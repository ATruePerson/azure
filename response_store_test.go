package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileResponseStoreEncryptsAndReloadsResponses(t *testing.T) {
	root := t.TempDir()
	store, err := newFileResponseStore(root)
	if err != nil {
		t.Fatal(err)
	}
	response := &ResponsesResponse{ID: "resp_1", Model: "test", Status: "completed"}
	if err := store.Put(response.ID, response); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(root, "responses.json.enc"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" || string(data) == `{"items"}` || containsPlaintext(string(data), "resp_1") {
		t.Fatalf("response history is not encrypted: %s", data)
	}

	reloaded, err := newFileResponseStore(root)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := reloaded.Get(response.ID)
	if !ok || got.ID != response.ID || got.Status != response.Status {
		t.Fatalf("reloaded response = %+v, found=%t", got, ok)
	}
}

func TestMemoryResponseStoreExpiresEntries(t *testing.T) {
	store := newMemoryResponseStore()
	store.items["old"] = storedResponse{
		SavedAt: time.Now().Add(-responseStoreMaxAge - time.Minute),
		Value:   &ResponsesResponse{ID: "old"},
	}
	if _, ok := store.Get("old"); ok {
		t.Fatal("expired response was returned")
	}
}

func containsPlaintext(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
