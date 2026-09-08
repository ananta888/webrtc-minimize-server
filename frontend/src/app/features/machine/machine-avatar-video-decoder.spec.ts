import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAvatarVideo } from "./machine-avatar-video-decoder";
import { parseAvatarVideo } from "./machine-avatar-video-contract";

afterEach(() => vi.restoreAllMocks());
function setup() {
  let resolve!: () => void;
  const pending = new Promise<void>(r => { resolve = r; });
  const video = { muted: false, defaultMuted: false, volume: 1, playsInline: false, loop: false, playbackRate: 1,
    src: '', preload: '', readyState: 2, videoWidth: 256, videoHeight: 256, duration: 1, error: null,
    play: vi.fn(() => pending), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
  vi.spyOn(document, "createElement").mockReturnValue(video as never);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => 'blob:test-owned') });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  const content = parseAvatarVideo({ mp4: btoa('0000ftyp00000000'), sha256: 'a'.repeat(64), frames: 12,
    repeatMode: 'loop', originKind: 'generated', classification: 'test_only' });
  return { video, resolve, content };
}
describe('owned silent blob decoder', () => {
  it('owns a muted element, validates metadata and never draws to a remote or capture surface', async () => {
    const f = setup(), decoder = decodeAvatarVideo(f.content);
    expect(f.video.muted).toBe(true); expect(f.video.defaultMuted).toBe(true); expect(f.video.volume).toBe(0);
    expect(f.video.loop).toBe(true); expect(decoder.ready()).toBe(true);
    const drawing = { drawImage: vi.fn() }; decoder.draw(drawing as never);
    expect(drawing.drawImage).toHaveBeenCalledExactlyOnceWith(f.video, 64, 40, 128, 128);
    decoder.close(); decoder.close(); expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-owned');
    expect(f.video.removeAttribute).toHaveBeenCalledExactlyOnceWith('src'); expect(f.video.load).toHaveBeenCalledOnce();
    f.resolve(); await decoder.settled; expect(f.video.pause).toHaveBeenCalledTimes(2);
    expect(() => decoder.ready()).toThrow('decoder_failed');
  });
  it.each([{ videoWidth: 2048 }, { videoHeight: 128 }, { duration: Number.NaN }, { duration: 11 }, { duration: 2 },
    { muted: false }, { volume: 1 }, { playbackRate: 2 }, { src: 'https://foreign' }, { loop: false }])('rejects mutated decoder metadata %j', async patch => {
    const f = setup(), decoder = decodeAvatarVideo(f.content); Object.assign(f.video, patch);
    expect(() => decoder.ready()).toThrow('metadata_invalid'); const drawing = { drawImage: vi.fn() };
    expect(() => decoder.draw(drawing as never)).toThrow(); expect(drawing.drawImage).not.toHaveBeenCalled();
    decoder.close(); f.resolve(); await decoder.settled;
  });
  it('hold_last does not loop and incomplete metadata cannot release pixels', async () => {
    const f = setup(); f.content.repeatMode = 'hold_last';
    const decoder = decodeAvatarVideo(f.content); expect(f.video.loop).toBe(false);
    f.video.readyState = 1; expect(decoder.ready()).toBe(false);
    expect(() => decoder.draw({ drawImage: vi.fn() } as never)).toThrow('not_ready');
    decoder.close(); f.resolve(); await decoder.settled;
  });
  it('rejected native playback and partial initialization release only owned resources', async () => {
    const f = setup(); f.video.play.mockRejectedValue(new Error('decoder'));
    const decoder = decodeAvatarVideo(f.content); await decoder.settled;
    expect(() => decoder.ready()).toThrow('decoder_failed'); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    const g = setup(); g.video.play.mockImplementation(() => { throw new Error('decoder'); });
    expect(() => decodeAvatarVideo(g.content)).toThrow('decoder'); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
