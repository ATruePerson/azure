package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ATruePerson/acc/codex"
)

const (
	responseStoreVersion = 1
	responseStoreMaxAge  = 24 * time.Hour
	responseStoreMaxSize = 100
)

// responseStore keeps previous_response_id state locally. The file-backed
// implementation encrypts the response payload with a per-config-root key,
// bounds its size, and expires entries so prompts do not become an unbounded
// plaintext transcript database.
type responseStore interface {
	Put(string, *ResponsesResponse) error
	Get(string) (*ResponsesResponse, bool)
}

type memoryResponseStore struct {
	mu    sync.RWMutex
	items map[string]storedResponse
}

type storedResponse struct {
	SavedAt time.Time          `json:"saved_at"`
	Value   *ResponsesResponse `json:"value"`
}

func newMemoryResponseStore() *memoryResponseStore {
	return &memoryResponseStore{items: make(map[string]storedResponse)}
}

func (s *memoryResponseStore) Put(id string, response *ResponsesResponse) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[id] = storedResponse{SavedAt: time.Now().UTC(), Value: cloneResponsesResponse(response)}
	pruneResponseItems(s.items, time.Now().UTC())
	return nil
}

func (s *memoryResponseStore) Get(id string) (*ResponsesResponse, bool) {
	s.mu.RLock()
	item, ok := s.items[id]
	s.mu.RUnlock()
	if !ok || item.Value == nil || time.Since(item.SavedAt) > responseStoreMaxAge {
		return nil, false
	}
	return cloneResponsesResponse(item.Value), true
}

type fileResponseStore struct {
	mu       sync.RWMutex
	dataPath string
	key      []byte
	items    map[string]storedResponse
}

type encryptedResponseFile struct {
	Version int    `json:"version"`
	Nonce   string `json:"nonce"`
	Payload string `json:"payload"`
}

type responseStorePayload struct {
	Items map[string]storedResponse `json:"items"`
}

func newFileResponseStore(root string) (*fileResponseStore, error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, fmt.Errorf("response store requires an absolute config root")
	}
	keyPath := filepath.Join(root, "responses.key")
	dataPath := filepath.Join(root, "responses.json.enc")
	key, err := loadOrCreateResponseKey(keyPath)
	if err != nil {
		return nil, err
	}
	s := &fileResponseStore{dataPath: dataPath, key: key, items: make(map[string]storedResponse)}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func loadOrCreateResponseKey(path string) ([]byte, error) {
	key, err := os.ReadFile(path)
	if err == nil {
		if len(key) != 32 {
			return nil, fmt.Errorf("response key has invalid length")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key = make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if err := codex.AtomicWriteFile(path, key, 0600); err != nil {
		return nil, err
	}
	return key, nil
}

func (s *fileResponseStore) load() error {
	b, err := os.ReadFile(s.dataPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var envelope encryptedResponseFile
	if err := json.Unmarshal(b, &envelope); err != nil {
		return fmt.Errorf("decode response history: %w", err)
	}
	if envelope.Version != responseStoreVersion {
		return fmt.Errorf("unsupported response history version %d", envelope.Version)
	}
	payload, err := decryptResponsePayload(s.key, envelope)
	if err != nil {
		return err
	}
	var decoded responseStorePayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode response history payload: %w", err)
	}
	if decoded.Items != nil {
		s.items = decoded.Items
	}
	pruneResponseItems(s.items, time.Now().UTC())
	return nil
}

func (s *fileResponseStore) Put(id string, response *ResponsesResponse) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[id] = storedResponse{SavedAt: time.Now().UTC(), Value: cloneResponsesResponse(response)}
	pruneResponseItems(s.items, time.Now().UTC())
	return s.persistLocked()
}

func (s *fileResponseStore) Get(id string) (*ResponsesResponse, bool) {
	s.mu.RLock()
	item, ok := s.items[id]
	s.mu.RUnlock()
	if !ok || item.Value == nil || time.Since(item.SavedAt) > responseStoreMaxAge {
		return nil, false
	}
	return cloneResponsesResponse(item.Value), true
}

func (s *fileResponseStore) persistLocked() error {
	payload, err := json.Marshal(responseStorePayload{Items: s.items})
	if err != nil {
		return err
	}
	envelope, err := encryptResponsePayload(s.key, payload)
	if err != nil {
		return err
	}
	b, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	return codex.AtomicWriteFile(s.dataPath, append(b, '\n'), 0600)
}

func encryptResponsePayload(key, payload []byte) (encryptedResponseFile, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return encryptedResponseFile{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return encryptedResponseFile{}, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return encryptedResponseFile{}, err
	}
	sealed := gcm.Seal(nil, nonce, payload, nil)
	return encryptedResponseFile{
		Version: responseStoreVersion,
		Nonce:   base64.RawStdEncoding.EncodeToString(nonce),
		Payload: base64.RawStdEncoding.EncodeToString(sealed),
	}, nil
}

func decryptResponsePayload(key []byte, envelope encryptedResponseFile) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, fmt.Errorf("decode response history nonce: %w", err)
	}
	sealed, err := base64.RawStdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return nil, fmt.Errorf("decode response history payload: %w", err)
	}
	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt response history: %w", err)
	}
	return plain, nil
}

func pruneResponseItems(items map[string]storedResponse, now time.Time) {
	for id, item := range items {
		if item.Value == nil || now.Sub(item.SavedAt) > responseStoreMaxAge {
			delete(items, id)
		}
	}
	for len(items) > responseStoreMaxSize {
		oldestID := ""
		var oldest time.Time
		for id, item := range items {
			if oldestID == "" || item.SavedAt.Before(oldest) {
				oldestID, oldest = id, item.SavedAt
			}
		}
		delete(items, oldestID)
	}
}
