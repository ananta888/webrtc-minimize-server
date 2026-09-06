package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var errOutputBusy = errors.New("native packager output already owned")

const outputOwnerFile = ".native-packager-owner-v1.json"

type outputOwner struct {
	Version     int    `json:"version"`
	PackagerID  string `json:"packagerId"`
	ResourceRef string `json:"resourceRef"`
	Generation  string `json:"generation"`
}

type outputOwnership struct {
	root, output string
	owner        outputOwner
	file         *os.File
	info         os.FileInfo
	once         sync.Once
	err          error
}

func prepareOutputRoot(root string) error {
	if !validOutputRoot(root) {
		return errors.New("invalid native-packager output root")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("native-packager output root must be a real directory")
	}
	return nil
}

func openOutputLock(path string, create bool) (*os.File, error) {
	flags := os.O_RDWR
	if create {
		flags |= os.O_CREATE
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("invalid native-packager output lock")
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	actual, statErr := file.Stat()
	listed, listErr := os.Lstat(path)
	if statErr != nil || listErr != nil || !listed.Mode().IsRegular() || !os.SameFile(actual, listed) {
		_ = file.Close()
		return nil, errors.New("native-packager output lock changed")
	}
	if err = lockOutputFile(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

func withOutputRootLock(root string, run func() error) error {
	if err := prepareOutputRoot(root); err != nil {
		return err
	}
	deadline := time.Now().Add(time.Second)
	for {
		file, err := openOutputLock(filepath.Join(root, ".native-packager-output.lock"), true)
		if err == nil {
			defer file.Close()
			return run()
		}
		if !errors.Is(err, errOutputBusy) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readOutputOwner(file *os.File) (outputOwner, error) {
	var owner outputOwner
	info, err := file.Stat()
	if err != nil || info.Size() < 1 || info.Size() > 1024 {
		return owner, errors.New("invalid native-packager output owner")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return owner, err
	}
	decoder := json.NewDecoder(io.LimitReader(file, 1025))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&owner); err != nil {
		return owner, errors.New("invalid native-packager output owner")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF || owner.Version != 1 || !packagerIDPattern.MatchString(owner.PackagerID) ||
		!resourceIDPattern.MatchString(owner.ResourceRef) || len(owner.Generation) != 32 {
		return owner, errors.New("invalid native-packager output owner")
	}
	if _, err = hex.DecodeString(owner.Generation); err != nil {
		return owner, errors.New("invalid native-packager output owner")
	}
	return owner, nil
}

// Must run under the root lock. Unknown, foreign and live output is preserved.
func removeOwnedOrphan(root, resource, packager string) (bool, error) {
	output, err := validatedOutputDirectory(root, resource)
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(output)
	if os.IsNotExist(err) {
		return true, nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, nil
	}
	file, err := openOutputLock(filepath.Join(output, outputOwnerFile), false)
	if err != nil {
		return false, nil
	}
	owner, readErr := readOutputOwner(file)
	_ = file.Close() // Root lock prevents any new acquisition while removing it.
	if readErr != nil || owner.PackagerID != packager || owner.ResourceRef != resource {
		return false, nil
	}
	return true, os.RemoveAll(output)
}

func cleanOutputRoot(root, packager string) error {
	if !packagerIDPattern.MatchString(packager) {
		return errors.New("invalid native-packager output owner")
	}
	return withOutputRootLock(root, func() error {
		entries, err := os.ReadDir(root)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if resourceIDPattern.MatchString(entry.Name()) {
				if _, err = removeOwnedOrphan(root, entry.Name(), packager); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func acquireOutputOwnership(root, resource, packager string) (*outputOwnership, error) {
	if !packagerIDPattern.MatchString(packager) {
		return nil, errors.New("invalid native-packager output owner")
	}
	output, err := validatedOutputDirectory(root, resource)
	if err != nil {
		return nil, err
	}
	var ownership *outputOwnership
	err = withOutputRootLock(root, func() error {
		available, err := removeOwnedOrphan(root, resource, packager)
		if err != nil {
			return err
		}
		if !available {
			return errOutputBusy
		}
		if err = os.Mkdir(output, 0o700); err != nil {
			return err
		}
		file, err := openOutputLock(filepath.Join(output, outputOwnerFile), true)
		if err != nil {
			_ = os.RemoveAll(output)
			return err
		}
		nonce := make([]byte, 16)
		if _, err = rand.Read(nonce); err != nil {
			_ = file.Close()
			_ = os.RemoveAll(output)
			return err
		}
		owner := outputOwner{1, packager, resource, hex.EncodeToString(nonce)}
		if err = json.NewEncoder(file).Encode(owner); err == nil {
			err = file.Sync()
		}
		info, statErr := os.Lstat(output)
		if err != nil || statErr != nil {
			_ = file.Close()
			_ = os.RemoveAll(output)
			return errors.New("native-packager output owner unavailable")
		}
		ownership = &outputOwnership{root: root, output: output, owner: owner, file: file, info: info}
		return nil
	})
	return ownership, err
}

func (ownership *outputOwnership) close() error {
	ownership.once.Do(func() {
		ownership.err = withOutputRootLock(ownership.root, func() error {
			current, err := os.Lstat(ownership.output)
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(current, ownership.info) {
				return errors.New("native-packager output ownership changed")
			}
			owner, err := readOutputOwner(ownership.file)
			if err != nil || owner != ownership.owner {
				return errors.New("native-packager output ownership changed")
			}
			actual, statErr := ownership.file.Stat()
			listed, listErr := os.Lstat(filepath.Join(ownership.output, outputOwnerFile))
			if statErr != nil || listErr != nil || !listed.Mode().IsRegular() || !os.SameFile(actual, listed) {
				return errors.New("native-packager output ownership changed")
			}
			_ = ownership.file.Close()
			return os.RemoveAll(ownership.output)
		})
		_ = ownership.file.Close()
	})
	return ownership.err
}
