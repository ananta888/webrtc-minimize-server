package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// Emulates the deferred Info lookup of an enumerated regular directory entry.
// Keeping the lookup lazy makes the rename/delete ordering deterministic even
// on filesystems which eagerly cache FileInfo while enumerating entries.
type sourceHLSListedFile struct{ path string }

func (e sourceHLSListedFile) Name() string               { return filepath.Base(e.path) }
func (e sourceHLSListedFile) IsDir() bool                { return false }
func (e sourceHLSListedFile) Type() fs.FileMode          { return 0 }
func (e sourceHLSListedFile) Info() (fs.FileInfo, error) { return os.Lstat(e.path) }

func TestSourceHLSInventoryToleratesCompletedRenameAndDelete(t *testing.T) {
	for _, mode := range []string{"rename", "delete"} {
		t.Run(mode, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "segment_000000000.m4s.tmp")
			if err := os.WriteFile(path, []byte("synthetic temporary"), 0600); err != nil {
				t.Fatal(err)
			}
			entry := sourceHLSListedFile{path: path}
			if _, err := entry.Info(); err != nil {
				t.Fatal(err)
			}
			var err error
			if mode == "rename" {
				err = os.Rename(path, path[:len(path)-4])
			} else {
				err = os.Remove(path)
			}
			if err != nil {
				t.Fatal(err)
			}
			if info, err := sourceHLSInventoryInfo(entry); err != nil || info != nil {
				t.Fatal("normal FFmpeg file transition aborted inventory")
			}
		})
	}
}

type sourceHLSInfoFailure struct {
	sourceHLSListedFile
	err error
}

func (e sourceHLSInfoFailure) Info() (fs.FileInfo, error) { return nil, e.err }

func TestSourceHLSInventoryPreservesOtherStatFailures(t *testing.T) {
	for _, failure := range []error{fs.ErrPermission, errors.New("fixture IO failure")} {
		if _, err := sourceHLSInventoryInfo(sourceHLSInfoFailure{err: failure}); !errors.Is(err, failure) {
			t.Fatal("inventory swallowed a non-missing file failure")
		}
	}
}
