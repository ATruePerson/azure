package main

import (
	"encoding/json"
	"fmt"
	"log"
)

// rememberResponse keeps the small amount of state needed for
// previous_response_id. It is intentionally local to one ACC process: the
// gateway never sends conversation state to a third party just to implement
// the Responses API contract.
func (s *server) rememberResponse(response *ResponsesResponse) {
	if response == nil || response.ID == "" {
		return
	}
	copyResponse := cloneResponsesResponse(response)
	if s.responses == nil {
		s.responses = newMemoryResponseStore()
	}
	if err := s.responses.Put(response.ID, copyResponse); err != nil {
		log.Printf("response history: save failed: %v", err)
	}
}

func (s *server) responseByID(id string) (*ResponsesResponse, bool) {
	if s.responses == nil {
		return nil, false
	}
	response, ok := s.responses.Get(id)
	if !ok {
		return nil, false
	}
	return cloneResponsesResponse(response), true
}

func cloneResponsesResponse(response *ResponsesResponse) *ResponsesResponse {
	if response == nil {
		return nil
	}
	b, err := json.Marshal(response)
	if err != nil {
		return nil
	}
	var copyResponse ResponsesResponse
	if err := json.Unmarshal(b, &copyResponse); err != nil {
		return nil
	}
	return &copyResponse
}

func (s *server) applyPreviousResponse(req *ResponsesRequest) error {
	if req == nil || req.PreviousResponseID == "" {
		return nil
	}
	previous, ok := s.responseByID(req.PreviousResponseID)
	if !ok {
		return fmt.Errorf("previous response %q was not found in this ACC process", req.PreviousResponseID)
	}

	items := append([]ResponsesItem(nil), previous.Output...)
	if len(req.Input) > 0 {
		var inputItems []ResponsesItem
		if err := json.Unmarshal(req.Input, &inputItems); err == nil {
			items = append(items, inputItems...)
		} else {
			var inputText string
			if err := json.Unmarshal(req.Input, &inputText); err != nil {
				return fmt.Errorf("previous response continuation has invalid input: %w", err)
			}
			content, _ := json.Marshal([]map[string]any{{"type": "input_text", "text": inputText}})
			items = append(items, ResponsesItem{Type: "message", Role: "user", Content: content})
		}
	}
	rewritten, err := json.Marshal(items)
	if err != nil {
		return fmt.Errorf("encode previous response continuation: %w", err)
	}
	req.Input = rewritten
	return nil
}
