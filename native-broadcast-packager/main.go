package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

const agentVersion = "0.4.0"

var packagerIDPattern = regexp.MustCompile(`^pkr_[A-Za-z0-9_-]{16,64}$`)
var enrollmentTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var ffmpegVersionPattern = regexp.MustCompile(`(?m)^ffmpeg version\s+(?:n)?([0-9]+)\.([0-9]+)`)

type config struct {
	controlURL, packagerID, identityFile, enrollmentToken, ffmpegPath, outputRoot string
	energyClass, uploadClass                                                      string
	maximumRenditions, maximumPixelsPerSecond                                     int
	stunURLs                                                                      []string
}

func loadConfig(getenv func(string) string) (config, error) {
	rawURL := strings.TrimSpace(getenv("NATIVE_PACKAGER_CONTROL_URL"))
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.Path != "/native-packager" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return config{}, errors.New("NATIVE_PACKAGER_CONTROL_URL must be an exact wss:// URL ending in /native-packager")
	}
	id := strings.TrimSpace(getenv("NATIVE_PACKAGER_ID"))
	if !packagerIDPattern.MatchString(id) {
		return config{}, errors.New("NATIVE_PACKAGER_ID is invalid")
	}
	identityFile := strings.TrimSpace(getenv("NATIVE_PACKAGER_IDENTITY_FILE"))
	if identityFile == "" || strings.ContainsAny(identityFile, "\x00\r\n") {
		return config{}, errors.New("NATIVE_PACKAGER_IDENTITY_FILE is required")
	}
	outputRoot := defaultValue(getenv("NATIVE_PACKAGER_OUTPUT_ROOT"), "/tmp/ananta-native-packager")
	if !filepath.IsAbs(outputRoot) || filepath.Clean(outputRoot) == string(filepath.Separator) || strings.ContainsAny(outputRoot, "\x00\r\n") {
		return config{}, errors.New("NATIVE_PACKAGER_OUTPUT_ROOT must be absolute")
	}
	token := strings.TrimSpace(getenv("NATIVE_PACKAGER_ENROLLMENT_TOKEN"))
	if token != "" && !enrollmentTokenPattern.MatchString(token) {
		return config{}, errors.New("NATIVE_PACKAGER_ENROLLMENT_TOKEN is invalid")
	}
	energy := defaultValue(getenv("NATIVE_PACKAGER_ENERGY_CLASS"), "ac")
	if !oneOf(energy, "battery", "ac-limited", "ac") {
		return config{}, errors.New("NATIVE_PACKAGER_ENERGY_CLASS is invalid")
	}
	upload := defaultValue(getenv("NATIVE_PACKAGER_UPLOAD_CLASS"), "5-15mbit")
	if !oneOf(upload, "under-5mbit", "5-15mbit", "over-15mbit") {
		return config{}, errors.New("NATIVE_PACKAGER_UPLOAD_CLASS is invalid")
	}
	renditions, err := envInt(getenv("NATIVE_PACKAGER_MAX_RENDITIONS"), 2, 1, 3)
	if err != nil {
		return config{}, err
	}
	pixels, err := envInt(getenv("NATIVE_PACKAGER_MAX_PIXELS_PER_SECOND"), 1280*720*30, 640*360*10, 1920*1080*60*3)
	if err != nil {
		return config{}, err
	}
	stunURLs, err := parseStunURLs(getenv("NATIVE_PACKAGER_STUN_URLS"))
	if err != nil {
		return config{}, err
	}
	return config{
		controlURL: rawURL, packagerID: id, identityFile: identityFile, enrollmentToken: token,
		ffmpegPath: defaultValue(getenv("NATIVE_PACKAGER_FFMPEG"), "ffmpeg"), outputRoot: filepath.Clean(outputRoot), energyClass: energy,
		uploadClass: upload, maximumRenditions: renditions, maximumPixelsPerSecond: pixels, stunURLs: stunURLs,
	}, nil
}

func parseStunURLs(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 8 {
		return nil, errors.New("NATIVE_PACKAGER_STUN_URLS exceeds 8 entries")
	}
	result := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		value := strings.TrimSpace(part)
		parsed, err := url.Parse(value)
		if err != nil || parsed == nil || (parsed.Scheme != "stun" && parsed.Scheme != "stuns") ||
			(parsed.Host == "" && parsed.Opaque == "") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || seen[value] {
			return nil, errors.New("NATIVE_PACKAGER_STUN_URLS contains an invalid URL")
		}
		seen[value] = true
		result = append(result, value)
	}
	return result, nil
}

func defaultValue(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}
func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}
func envInt(raw string, fallback, minimum, maximum int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("value must be between %d and %d", minimum, maximum)
	}
	return value, nil
}

type publicKey struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	Ext bool   `json:"ext"`
}
type identity struct {
	privateKey *ecdsa.PrivateKey
	publicKey  publicKey
}

func identityFromKey(key *ecdsa.PrivateKey) *identity {
	coordinate := func(value *big.Int) string {
		bytes := make([]byte, 32)
		value.FillBytes(bytes)
		return base64.RawURLEncoding.EncodeToString(bytes)
	}
	return &identity{key, publicKey{"EC", "P-256", coordinate(key.X), coordinate(key.Y), true}}
}

func loadIdentity(filename string) (*identity, error) {
	raw, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" || len(rest) != 0 {
		return nil, errors.New("invalid native-packager identity")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(*ecdsa.PrivateKey)
	if err != nil || !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("invalid native-packager P-256 identity")
	}
	return identityFromKey(key), nil
}

func loadOrCreateIdentity(filename string) (*identity, error) {
	loaded, err := loadIdentity(filename)
	if err == nil {
		return loaded, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(filename), ".native-packager-identity-")
	if err != nil {
		return nil, err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0o600); err == nil {
		err = pem.Encode(temporary, &pem.Block{Type: "PRIVATE KEY", Bytes: encoded})
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	if err = os.Link(name, filename); errors.Is(err, os.ErrExist) {
		return loadIdentity(filename)
	}
	if err != nil {
		return nil, err
	}
	return identityFromKey(key), nil
}

func (value *identity) sign(message string) (string, error) {
	digest := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, value.privateKey, digest[:])
	if err != nil {
		return "", err
	}
	proof := make([]byte, 64)
	r.FillBytes(proof[:32])
	s.FillBytes(proof[32:])
	return base64.RawURLEncoding.EncodeToString(proof), nil
}

func authMessage(id, nonce string, timestamp int64) string {
	return fmt.Sprintf("native-packager-auth-v1\n%s\n%s\n%d", id, nonce, timestamp)
}
func enrollMessage(id, nonce string, timestamp int64, token string, key publicKey) string {
	return fmt.Sprintf("native-packager-enroll-v1\n%s\n%s\n%d\n%s\n%s\n%s", id, nonce, timestamp, token, key.X, key.Y)
}
func operatorProvisioningMessage(id, owner, label, platform string, key publicKey) string {
	return fmt.Sprintf("native-packager-operator-provision-v1\n%s\n%s\n%s\n%s\n%s\n%s",
		id, owner, label, platform, key.X, key.Y)
}

type operatorProvisioningManifest struct {
	Version        int       `json:"version"`
	Type           string    `json:"type"`
	PackagerID     string    `json:"packagerId"`
	OwnerPrincipal string    `json:"ownerPrincipal"`
	Label          string    `json:"label"`
	Platform       string    `json:"platform"`
	PublicKey      publicKey `json:"publicKey"`
	Proof          string    `json:"proof"`
}

func normalizeOperatorOwner(raw string) (string, error) {
	owner := strings.TrimSpace(raw)
	separator := strings.LastIndex(owner, "|")
	if len(owner) > 1024 || separator < 1 || separator == len(owner)-1 || strings.ContainsAny(owner, "\x00\r\n") {
		return "", errors.New("invalid native-packager owner principal")
	}
	return owner, nil
}

func createOperatorProvisioningManifest(cfg config, identity *identity, ownerRaw, labelRaw, platformRaw string) (operatorProvisioningManifest, error) {
	owner, err := normalizeOperatorOwner(ownerRaw)
	if err != nil {
		return operatorProvisioningManifest{}, err
	}
	label := strings.Join(strings.Fields(labelRaw), " ")
	if len(label) < 1 || len(label) > 48 || strings.ContainsAny(label, "\x00\r\n") {
		return operatorProvisioningManifest{}, errors.New("invalid native-packager label")
	}
	platform := strings.ToLower(strings.TrimSpace(platformRaw))
	if !oneOf(platform, "linux", "macos", "windows") {
		return operatorProvisioningManifest{}, errors.New("invalid native-packager platform")
	}
	proof, err := identity.sign(operatorProvisioningMessage(cfg.packagerID, owner, label, platform, identity.publicKey))
	if err != nil {
		return operatorProvisioningManifest{}, err
	}
	return operatorProvisioningManifest{
		Version: 1, Type: "native-packager-operator-provisioning", PackagerID: cfg.packagerID,
		OwnerPrincipal: owner, Label: label, Platform: platform, PublicKey: identity.publicKey, Proof: proof,
	}, nil
}

type ffmpegCapability struct {
	version                      string
	videoEncoders, audioEncoders []string
	health                       string
}

func probeFFmpeg(ctx context.Context, executable string) (ffmpegCapability, error) {
	versionOutput, err := exec.CommandContext(ctx, executable, "-hide_banner", "-version").CombinedOutput()
	if err != nil {
		return ffmpegCapability{}, fmt.Errorf("ffmpeg version probe failed")
	}
	match := ffmpegVersionPattern.FindStringSubmatch(string(versionOutput))
	if len(match) != 3 {
		return ffmpegCapability{}, errors.New("ffmpeg version is not understood")
	}
	major, _ := strconv.Atoi(match[1])
	if major < 6 {
		return ffmpegCapability{}, errors.New("FFmpeg 6 or newer is required")
	}
	encoderOutput, err := exec.CommandContext(ctx, executable, "-hide_banner", "-encoders").CombinedOutput()
	if err != nil {
		return ffmpegCapability{}, errors.New("ffmpeg encoder probe failed")
	}
	text := string(encoderOutput)
	video := []string{}
	for _, encoder := range []string{"libx264", "h264_nvenc", "h264_vaapi", "h264_videotoolbox"} {
		if strings.Contains(text, " "+encoder+" ") {
			video = append(video, encoder)
		}
	}
	if len(video) == 0 || video[0] != "libx264" || !strings.Contains(text, " aac ") {
		return ffmpegCapability{}, errors.New("libx264 and AAC encoders are required")
	}
	return ffmpegCapability{fmt.Sprintf("%s.%s", match[1], match[2]), video, []string{"aac"}, "healthy"}, nil
}

func cpuClass() string {
	if runtime.NumCPU() >= 12 {
		return "high"
	}
	if runtime.NumCPU() >= 6 {
		return "medium"
	}
	return "low"
}
func hardwareClass() string {
	if runtime.NumCPU() >= 12 {
		return "large"
	}
	if runtime.NumCPU() >= 6 {
		return "medium"
	}
	return "small"
}

func createWebRTCAPI() (*webrtc.API, error) {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, fmt.Errorf("register WebRTC audio codec: %w", err)
	}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeVP8, ClockRate: 90000,
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"},
				{Type: "nack"}, {Type: "nack", Parameter: "pli"},
			},
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register WebRTC video codec: %w", err)
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return nil, fmt.Errorf("register WebRTC interceptors: %w", err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry)), nil
}

type serverMessage struct {
	Version         int                        `json:"version"`
	Type            string                     `json:"type"`
	Nonce           string                     `json:"nonce,omitempty"`
	PackagerID      string                     `json:"packagerId,omitempty"`
	KeyFingerprint  string                     `json:"keyFingerprint,omitempty"`
	Code            string                     `json:"code,omitempty"`
	ExpiresAt       int64                      `json:"expiresAt,omitempty"`
	ObservedAt      int64                      `json:"observedAt,omitempty"`
	RoomIDs         []string                   `json:"roomIds,omitempty"`
	AssignmentID    string                     `json:"assignmentId,omitempty"`
	RoomID          string                     `json:"roomId,omitempty"`
	ProgramID       string                     `json:"programId,omitempty"`
	ProgramEpoch    int                        `json:"programEpoch,omitempty"`
	LeaseID         string                     `json:"leaseId,omitempty"`
	FencingRevision int                        `json:"fencingRevision,omitempty"`
	ResourceRef     string                     `json:"resourceRef,omitempty"`
	ReasonCode      string                     `json:"reasonCode,omitempty"`
	Profile         assignmentProfile          `json:"profile,omitempty"`
	PublisherPeerID string                     `json:"publisherPeerId,omitempty"`
	Description     *webrtc.SessionDescription `json:"description,omitempty"`
	Candidate       json.RawMessage            `json:"candidate,omitempty"`
}

type client struct {
	cfg          config
	identity     *identity
	capability   ffmpegCapability
	mu           sync.Mutex
	roomsMu      sync.RWMutex
	connection   *websocket.Conn
	rooms        []string
	assignmentMu sync.Mutex
	assignment   *packagerAssignment
	api          *webrtc.API
	sendOverride func(any) error
}

func (c *client) send(value any) error {
	if c.sendOverride != nil {
		return c.sendOverride(value)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.connection == nil {
		return errors.New("control unavailable")
	}
	_ = c.connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.connection.WriteJSON(value)
}
func (c *client) capabilityMessage() map[string]any {
	c.roomsMu.RLock()
	rooms := append([]string(nil), c.rooms...)
	c.roomsMu.RUnlock()
	now := time.Now().UnixMilli()
	gpu := "none"
	if len(c.capability.videoEncoders) > 1 {
		gpu = "integrated"
	}
	return map[string]any{"version": 1, "type": "capability", "capability": map[string]any{
		"capabilityVersion": 1, "agentId": c.cfg.packagerID, "tenantId": "tn_0000000000000000", "ownerSubjectRef": "sub_0000000000000000",
		"deviceRef": "dev_0000000000000000", "agentVersion": agentVersion, "ffmpegVersion": c.capability.version,
		"videoEncoders": c.capability.videoEncoders, "audioEncoders": c.capability.audioEncoders, "hardwareClass": hardwareClass(),
		"cpuClass": cpuClass(), "gpuClass": gpu, "uploadClass": c.cfg.uploadClass, "energyClass": c.cfg.energyClass, "health": c.capability.health,
		"maximumRenditions": c.cfg.maximumRenditions, "maximumPixelsPerSecond": c.cfg.maximumPixelsPerSecond,
		"consentedRoomIds": rooms, "observedAt": now, "expiresAt": now + 30000,
	}}
}

func (c *client) connect(ctx context.Context, enroll bool) error {
	defer c.closeAssignmentMedia()
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, EnableCompression: false, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	connection, response, err := dialer.DialContext(ctx, c.cfg.controlURL, http.Header{})
	if err != nil {
		if response != nil {
			return fmt.Errorf("control status %d", response.StatusCode)
		}
		return errors.New("control connection failed")
	}
	defer connection.Close()
	connection.SetReadLimit(96 * 1024)
	c.mu.Lock()
	c.connection = connection
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.connection = nil; c.mu.Unlock() }()
	connectionDone := make(chan struct{})
	defer close(connectionDone)
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "packager_shutdown"),
				time.Now().Add(time.Second))
			_ = connection.Close()
		case <-connectionDone:
		}
	}()
	_, raw, err := connection.ReadMessage()
	if err != nil {
		return err
	}
	challenge, decodeErr := decodeServerMessage(raw)
	if decodeErr != nil || challenge.Type != "packager-challenge" || challenge.Nonce == "" || challenge.ExpiresAt <= time.Now().UnixMilli() {
		return errors.New("invalid control challenge")
	}
	timestamp := time.Now().UnixMilli()
	if enroll {
		proof, signErr := c.identity.sign(enrollMessage(c.cfg.packagerID, challenge.Nonce, timestamp, c.cfg.enrollmentToken, c.identity.publicKey))
		if signErr != nil {
			return signErr
		}
		if err = c.send(map[string]any{"version": 1, "type": "enroll", "packagerId": c.cfg.packagerID, "enrollmentToken": c.cfg.enrollmentToken, "timestamp": timestamp, "publicKey": c.identity.publicKey, "proof": proof}); err != nil {
			return err
		}
		_, raw, err = connection.ReadMessage()
		if err != nil {
			return err
		}
		result, resultErr := decodeServerMessage(raw)
		if resultErr != nil || result.Type != "packager-enrolled" || result.PackagerID != c.cfg.packagerID {
			return errors.New("native packager enrollment rejected")
		}
		return nil
	}
	proof, err := c.identity.sign(authMessage(c.cfg.packagerID, challenge.Nonce, timestamp))
	if err != nil {
		return err
	}
	if err = c.send(map[string]any{"version": 1, "type": "authenticate", "packagerId": c.cfg.packagerID, "timestamp": timestamp, "proof": proof}); err != nil {
		return err
	}
	periodicDone := make(chan struct{})
	defer close(periodicDone)
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-periodicDone:
				return
			case <-ticker.C:
				_ = c.expireAssignment(time.Now())
				_ = c.send(c.capabilityMessage())
				_ = c.send(c.heartbeatMessage())
			}
		}
	}()
	for {
		_, raw, err = connection.ReadMessage()
		if err != nil {
			return err
		}
		message, decodeErr := decodeServerMessage(raw)
		if decodeErr != nil {
			return decodeErr
		}
		switch message.Type {
		case "packager-authenticated":
			if message.PackagerID != c.cfg.packagerID {
				return errors.New("invalid authentication response")
			}
		case "room-consent-sync":
			if len(message.RoomIDs) > 20 {
				return errors.New("too many room consents")
			}
			c.roomsMu.Lock()
			c.rooms = append([]string(nil), message.RoomIDs...)
			c.roomsMu.Unlock()
			if err = c.send(c.capabilityMessage()); err != nil {
				return err
			}
		case "capability-accepted":
		case "assignment-prepare":
			if err = c.prepareAssignment(message, time.Now()); err != nil {
				return err
			}
		case "assignment-stop":
			if err = c.stopAssignment(message); err != nil {
				return err
			}
		case "assignment-renew":
			if err = c.renewAssignment(message, time.Now()); err != nil {
				return err
			}
		case "assignment-peer-signal":
			if err = c.handleAssignmentSignal(message); err != nil {
				return err
			}
		case "packager-error":
			return fmt.Errorf("control rejected message: %s", message.Code)
		default:
			return errors.New("unknown control message")
		}
	}
}

func main() {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	identity, err := loadOrCreateIdentity(cfg.identityFile)
	if err != nil {
		log.Fatal("identity unavailable")
	}
	if len(os.Args) == 2 && os.Args[1] == "operator-manifest" {
		owner, readErr := os.ReadFile("/dev/stdin")
		if readErr != nil || len(owner) < 2 || len(owner) > 2048 {
			log.Fatal("owner principal unavailable")
		}
		manifest, manifestErr := createOperatorProvisioningManifest(
			cfg, identity, string(owner), os.Getenv("NATIVE_PACKAGER_LABEL"), os.Getenv("NATIVE_PACKAGER_PLATFORM"),
		)
		if manifestErr != nil {
			log.Fatal(manifestErr)
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetEscapeHTML(false)
		if err = encoder.Encode(manifest); err != nil {
			log.Fatal("operator manifest unavailable")
		}
		return
	}
	probeContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	capability, err := probeFFmpeg(probeContext, cfg.ffmpegPath)
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	if err = cleanOutputRoot(cfg.outputRoot); err != nil {
		log.Fatal("native packager output unavailable")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	api, err := createWebRTCAPI()
	if err != nil {
		log.Fatal(err)
	}
	client := &client{cfg: cfg, identity: identity, capability: capability, api: api}
	if len(os.Args) == 2 && os.Args[1] == "enroll" {
		if cfg.enrollmentToken == "" {
			log.Fatal("enrollment token required")
		}
		if err = client.connect(ctx, true); err != nil {
			log.Fatal(err)
		}
		log.Print("native broadcast packager enrolled")
		return
	}
	if len(os.Args) != 1 {
		log.Fatal("usage: native-broadcast-packager [enroll|operator-manifest]")
	}
	backoff := time.Second
	for ctx.Err() == nil {
		if err = client.connect(ctx, false); err != nil && ctx.Err() == nil {
			log.Printf("control connection ended: %v", err)
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}
