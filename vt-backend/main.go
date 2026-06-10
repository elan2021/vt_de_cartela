package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/joakimcarlsson/ai/agent"
	llmdeepseek "github.com/joakimcarlsson/ai/llm/deepseek"
	llmopenai "github.com/joakimcarlsson/ai/llm/openai"
	"github.com/joakimcarlsson/ai/model"
	"github.com/joakimcarlsson/ai/session"
	"github.com/joakimcarlsson/ai/tool"
)

// Tool: GenerateVT creates a video cartela
type GenerateVTTool struct {
	CartelasAPI    string
	RenderAsyncAPI string
	RenderHost     string
}

func (t *GenerateVTTool) Info() tool.Info {
	return tool.Info{
		Name:        "generate_vt",
		Description: "Gera um vídeo VT de varejo com cartelas de produtos. Use quando o usuário pedir para criar um comercial de TV para varejo.",
		Parameters: map[string]any{
			"store_name": map[string]any{
				"type":        "string",
				"description": "Nome da loja/rede varejista",
			},
			"products": map[string]any{
				"type":        "array",
				"description": "Lista de produtos com preço",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name":  map[string]any{"type": "string"},
						"price": map[string]any{"type": "string"},
					},
				},
			},
			"template": map[string]any{
				"type":        "string",
				"description": "Template a usar: classica, flash",
				"enum":        []string{"classica", "flash"},
			},
			"badge": map[string]any{
				"type":        "string",
				"description": "Texto do badge/destaque (ex: OFERTA, PROMOCAO)",
			},
			"narration": map[string]any{
				"type":        "string",
				"description": "Texto da narração para TTS",
			},
		},
		Required: []string{"store_name", "products", "template"},
	}
}

func (t *GenerateVTTool) Run(ctx context.Context, params tool.Call) (tool.Response, error) {
	var input struct {
		StoreName string `json:"store_name"`
		Products  []struct {
			Name  string `json:"name"`
			Price string `json:"price"`
		} `json:"products"`
		Template  string `json:"template"`
		Badge     string `json:"badge"`
		Narration string `json:"narration"`
	}

	if err := json.Unmarshal([]byte(params.Input), &input); err != nil {
		return tool.NewTextErrorResponse("Invalid input: " + err.Error()), nil
	}

	// Generate narration if not provided
	if input.Narration == "" {
		var narration []string
		narration = append(narration, fmt.Sprintf("Atenção, clientes do %s!", input.StoreName))
		for _, p := range input.Products {
			narration = append(narration, fmt.Sprintf("%s por apenas %s!", p.Name, p.Price))
		}
		narration = append(narration, "Não perca essa oportunidade!")
		input.Narration = strings.Join(narration, " ")
	}

	// Start async render
	renderPayload := map[string]any{
		"store_name":  input.StoreName,
		"products":    input.Products,
		"template":    input.Template,
		"badge":       input.Badge,
		"narration":   input.Narration,
		"product_name": input.StoreName,
	}
	renderJSON, _ := json.Marshal(renderPayload)

	renderResp, err := http.Post(
		t.RenderAsyncAPI+"/render-async",
		"application/json",
		strings.NewReader(string(renderJSON)),
	)
	if err != nil {
		log.Printf("[vt] Error starting render: %v", err)
		return tool.NewTextErrorResponse("Erro ao iniciar render: "+err.Error()), nil
	}
	defer renderResp.Body.Close()

	var renderResult struct {
		RenderID    string `json:"render_id"`
		Status      string `json:"status"`
		CheckURL    string `json:"check_url"`
		DownloadURL string `json:"download_url"`
	}
	if err := json.NewDecoder(renderResp.Body).Decode(&renderResult); err != nil {
		log.Printf("[vt] Error decoding render response: %v", err)
		return tool.NewTextErrorResponse("Erro ao decodificar resposta do render"), nil
	}

	log.Printf("[vt] Render started: %s -> %s", renderResult.RenderID, renderResult.DownloadURL)

	// Start TTS in background with error tracking via channel
	ttsDone := make(chan error, 1)
	go func() {
		defer close(ttsDone)
		ttsPayload := map[string]string{
			"text":       input.Narration,
			"voice_name": "Marlon",
		}
		ttsJSON, _ := json.Marshal(ttsPayload)

		ttsResp, err := http.Post(
			t.CartelasAPI+"/tts-generate",
			"application/json",
			strings.NewReader(string(ttsJSON)),
		)
		if err != nil {
			log.Printf("[vt] Error calling TTS API: %v", err)
			ttsDone <- err
			return
		}
		defer ttsResp.Body.Close()
		if ttsResp.StatusCode != http.StatusOK {
			log.Printf("[vt] TTS API returned status %d", ttsResp.StatusCode)
			ttsDone <- fmt.Errorf("TTS API returned status %d", ttsResp.StatusCode)
			return
		}
		log.Printf("[vt] TTS generated successfully")
		ttsDone <- nil
	}()
	// Log TTS result (non-blocking)
	go func() {
		if err := <-ttsDone; err != nil {
			log.Printf("[vt] TTS background task failed: %v", err)
		}
	}()

	result := map[string]any{
		"status":       "video_created",
		"render_id":    renderResult.RenderID,
		"download_url": fmt.Sprintf("%s%s", t.RenderHost, renderResult.DownloadURL),
		"check_url":    fmt.Sprintf("%s%s", t.RenderHost, renderResult.CheckURL),
		"store_name":   input.StoreName,
		"products":     input.Products,
		"template":     input.Template,
		"badge":        input.Badge,
		"narration":    input.Narration,
		"message":      fmt.Sprintf("VT para %s iniciado! Render ID: %s. O vídeo estará pronto em alguns minutos.", input.StoreName, renderResult.RenderID),
	}

	data, _ := json.Marshal(result)
	return tool.NewTextResponse(string(data)), nil
}

// Tool: GenerateNarration creates narration text for VT
type GenerateNarrationTool struct{}

func (t *GenerateNarrationTool) Info() tool.Info {
	return tool.Info{
		Name:        "generate_narration",
		Description: "Gera texto de narração profissional para VT de varejo. Use quando precisar criar o roteiro de áudio do comercial.",
		Parameters: map[string]any{
			"products": map[string]any{
				"type":        "array",
				"description": "Lista de produtos com preço",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name":  map[string]any{"type": "string"},
						"price": map[string]any{"type": "string"},
					},
				},
			},
			"store_name": map[string]any{
				"type":        "string",
				"description": "Nome da loja",
			},
			"style": map[string]any{
				"type":        "string",
				"description": "Estilo da narração",
				"enum":        []string{"urgente", "classico", "energetico"},
			},
		},
		Required: []string{"products", "store_name"},
	}
}

func (t *GenerateNarrationTool) Run(ctx context.Context, params tool.Call) (tool.Response, error) {
	var input struct {
		Products []struct {
			Name  string `json:"name"`
			Price string `json:"price"`
		} `json:"products"`
		StoreName string `json:"store_name"`
		Style     string `json:"style"`
	}

	if err := json.Unmarshal([]byte(params.Input), &input); err != nil {
		return tool.NewTextErrorResponse("Invalid input: " + err.Error()), nil
	}

	if input.Style == "" {
		input.Style = "urgente"
	}

	// Generate narration based on Jean Slim's style
	var narration []string
	narration = append(narration, fmt.Sprintf("Atenção, clientes do %s!", input.StoreName))

	for _, p := range input.Products {
		narration = append(narration, fmt.Sprintf("%s por apenas %s!", p.Name, p.Price))
	}

	narration = append(narration, "Não perca essa oportunidade!")

	result := map[string]any{
		"narration": strings.Join(narration, " "),
		"segments":  narration,
		"style":     input.Style,
		"tip":       "Texto curto e direto para cada cartela. Tom urgente de varejo.",
	}

	data, _ := json.Marshal(result)
	return tool.NewTextResponse(string(data)), nil
}

// Tool: ListVoices lists available TTS voices
type ListVoicesTool struct {
	CartelasAPI string
}

func (t *ListVoicesTool) Info() tool.Info {
	return tool.Info{
		Name:        "list_voices",
		Description: "Lista vozes disponíveis para narração TTS",
		Parameters:  map[string]any{},
		Required:    []string{},
	}
}

func (t *ListVoicesTool) Run(ctx context.Context, params tool.Call) (tool.Response, error) {
	// Call cartelas API
	resp, err := http.Get(t.CartelasAPI + "/tts-voices")
	if err != nil {
		return tool.NewTextErrorResponse("Erro ao buscar vozes: " + err.Error()), nil
	}
	defer resp.Body.Close()

	var voices struct {
		Voices []struct {
			Name string `json:"name"`
			Size int    `json:"size"`
		} `json:"voices"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&voices); err != nil {
		return tool.NewTextErrorResponse("Erro ao decodificar vozes: " + err.Error()), nil
	}

	data, _ := json.Marshal(voices)
	return tool.NewTextResponse(string(data)), nil
}

// Tool: GenerateTTS generates audio narration
type GenerateTTSTool struct {
	CartelasAPI string
}

func (t *GenerateTTSTool) Info() tool.Info {
	return tool.Info{
		Name:        "generate_tts",
		Description: "Gera áudio de narração a partir do texto. Use para criar o áudio do VT.",
		Parameters: map[string]any{
			"text": map[string]any{
				"type":        "string",
				"description": "Texto para narração",
			},
			"voice_name": map[string]any{
				"type":        "string",
				"description": "Nome da voz (padrão: Marlon)",
			},
		},
		Required: []string{"text"},
	}
}

func (t *GenerateTTSTool) Run(ctx context.Context, params tool.Call) (tool.Response, error) {
	var input struct {
		Text      string `json:"text"`
		VoiceName string `json:"voice_name"`
	}

	if err := json.Unmarshal([]byte(params.Input), &input); err != nil {
		return tool.NewTextErrorResponse("Invalid input: " + err.Error()), nil
	}

	if input.VoiceName == "" {
		input.VoiceName = "Marlon"
	}

	// Call cartelas API with timeout and error handling
	ttsClient := &http.Client{Timeout: 30 * time.Second}
	ttsPayload := map[string]string{
		"text":       input.Text,
		"voice_name": input.VoiceName,
	}
	ttsJSON, _ := json.Marshal(ttsPayload)

	resp, err := ttsClient.Post(
		t.CartelasAPI+"/tts-generate",
		"application/json",
		strings.NewReader(string(ttsJSON)),
	)
	if err != nil {
		log.Printf("[tts] Error calling TTS API: %v", err)
		return tool.NewTextErrorResponse("Erro ao gerar áudio: " + err.Error()), nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[tts] TTS API returned status %d", resp.StatusCode)
		return tool.NewTextErrorResponse(fmt.Sprintf("API de TTS retornou erro %d", resp.StatusCode)), nil
	}

	log.Printf("[tts] TTS generated successfully: voice=%s, text_len=%d", input.VoiceName, len(input.Text))

	result := map[string]any{
		"status":     "tts_generated",
		"text":       input.Text,
		"voice_name": input.VoiceName,
		"message":    fmt.Sprintf("Áudio gerado com voz %s.", input.VoiceName),
	}

	data, _ := json.Marshal(result)
	return tool.NewTextResponse(string(data)), nil
}

// Tool: GetVTSpecs returns VT technical specifications
type GetVTSpecsTool struct{}

func (t *GetVTSpecsTool) Info() tool.Info {
	return tool.Info{
		Name:        "get_vt_specs",
		Description: "Retorna especificações técnicas para produção de VT de varejo (resolução, FPS, codec, etc)",
		Parameters:  map[string]any{},
		Required:    []string{},
	}
}

func (t *GetVTSpecsTool) Run(ctx context.Context, params tool.Call) (tool.Response, error) {
	specs := map[string]any{
		"resolution": "1920x1080 (Full HD)",
		"fps":        "29.97 (NTSC)",
		"codec":      "H.264 ou ProRes 422",
		"audio":      "-23 LUFS (loudness normalizado)",
		"formats":    ".mp4, .mov, .mxf",
		"durations": map[string]string{
			"chamada":   "15s",
			"padrao":    "30s",
			"estendido": "45s-60s",
			"bumper":    "5s-10s",
		},
		"tips": []string{
			"Preço sempre em destaque — maior elemento visual",
			"Fonte bold, condensed, maiúscula para preços",
			"Cores primárias fortes: vermelho, amarelo, verde",
			"Animações rápidas: 8-15 frames por elemento",
			"Trilha energizada, sincronizada com cortes",
		},
	}

	data, _ := json.Marshal(specs)
	return tool.NewTextResponse(string(data)), nil
}

// Tool: PriceCalculator calculates VT pricing
type PriceCalculatorTool struct{}

func (t *PriceCalculatorTool) Info() tool.Info {
	return tool.Info{
		Name:        "calculate_price",
		Description: "Calcula o preço estimado de um VT de varejo baseado nos parâmetros",
		Parameters: map[string]any{
			"num_products": map[string]any{
				"type":        "integer",
				"description": "Número de produtos",
			},
			"has_3d": map[string]any{
				"type":        "boolean",
				"description": "Se usa selos 3D/Cinema 4D",
			},
			"duration": map[string]any{
				"type":        "string",
				"description": "Duração do VT",
				"enum":        []string{"15s", "30s", "45s", "60s"},
			},
			"urgency": map[string]any{
				"type":        "string",
				"description": "Nível de urgência",
				"enum":        []string{"normal", "24h", "express"},
			},
			"is_monthly": map[string]any{
				"type":        "boolean",
				"description": "Se é contrato mensal (desconto de 15-25%)",
			},
		},
		Required: []string{"num_products"},
	}
}

func (t *PriceCalculatorTool) Run(ctx context.Context, params tool.Call) (tool.Response, error) {
	var input struct {
		NumProducts int    `json:"num_products"`
		Has3D       bool   `json:"has_3d"`
		Duration    string `json:"duration"`
		Urgency     string `json:"urgency"`
		IsMonthly   bool   `json:"is_monthly"`
	}

	if err := json.Unmarshal([]byte(params.Input), &input); err != nil {
		return tool.NewTextErrorResponse("Invalid input: " + err.Error()), nil
	}

	if input.Duration == "" {
		input.Duration = "30s"
	}
	if input.Urgency == "" {
		input.Urgency = "normal"
	}

	// Base price calculation
	var basePrice float64
	if input.Has3D {
		basePrice = 800 + float64(input.NumProducts)*150
	} else {
		basePrice = 500 + float64(input.NumProducts)*100
	}

	// Duration multiplier
	switch input.Duration {
	case "45s", "60s":
		basePrice *= 1.5
	case "15s":
		basePrice *= 0.7
	}

	// Urgency multiplier
	switch input.Urgency {
	case "24h":
		basePrice *= 1.4
	case "express":
		basePrice *= 1.5
	}

	// Monthly discount
	monthlyPrice := basePrice
	if input.IsMonthly {
		monthlyPrice = basePrice * 0.8 // 20% discount
	}

	result := map[string]any{
		"base_price":    fmt.Sprintf("R$ %.2f", basePrice),
		"monthly_price": fmt.Sprintf("R$ %.2f", monthlyPrice),
		"currency":      "BRL",
		"parameters": map[string]any{
			"products": input.NumProducts,
			"has_3d":   input.Has3D,
			"duration": input.Duration,
			"urgency":  input.Urgency,
		},
		"notes": []string{
			"Valores de referência — ajustar conforme mercado local",
			"Contrato mensal oferece desconto de 15-25%",
			"Urgência (24h) cobra acréscimo de 30-50%",
		},
	}

	data, _ := json.Marshal(result)
	return tool.NewTextResponse(string(data)), nil
}

func cleanOldSessions(sessionsDir string, maxAge time.Duration) {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		log.Printf("[cleanup] Error reading sessions dir: %v", err)
		return
	}

	now := time.Now()
	cleaned := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > maxAge {
			path := filepath.Join(sessionsDir, entry.Name())
			if err := os.Remove(path); err != nil {
				log.Printf("[cleanup] Error removing %s: %v", path, err)
			} else {
				cleaned++
			}
		}
	}
	if cleaned > 0 {
		log.Printf("[cleanup] Removed %d old sessions", cleaned)
	}
}

// Auth middleware — protege endpoints com token
func authMiddleware(apiToken string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if apiToken != "" {
			token := r.Header.Get("Authorization")
			if !strings.HasPrefix(token, "Bearer ") {
				http.Error(w, `{"error":"missing authorization"}`, http.StatusUnauthorized)
				return
			}
			if subtle.ConstantTimeCompare([]byte(token[7:]), []byte(apiToken)) != 1 {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}
		}
		next(w, r)
	}
}

// CORS middleware
func corsMiddleware(allowedOrigin string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

// sanitizeInput previne prompt injection básico
func sanitizeInput(msg string) string {
	// Remove tokens de system prompt conhecidos
	msg = strings.ReplaceAll(msg, "Ignore all previous instructions", "")
	msg = strings.ReplaceAll(msg, "Ignore todas as instruções", "")
	msg = strings.ReplaceAll(msg, "You are now", "você é")
	msg = strings.ReplaceAll(msg, "System:", "Sistema:")
	// Limita tamanho máximo
	if len(msg) > 4000 {
		msg = msg[:4000]
	}
	return msg
}

func main() {
	// Load system prompt from file
	jeanSlimSystemPrompt := "Você é Jean Slim, especialista em VT de varejo."
	if data, err := os.ReadFile("prompt.md"); err == nil {
		jeanSlimSystemPrompt = string(data)
	} else {
		log.Printf("[warn] Could not load prompt.md: %v — using fallback prompt", err)
	}

	// Get DeepSeek API key
	apiKey := os.Getenv("DEEPSEEK_API_KEY")
	if apiKey == "" {
		log.Fatal("DEEPSEEK_API_KEY environment variable is required")
	}

	cartelasAPI := os.Getenv("CARTELAS_API")
	if cartelasAPI == "" {
		cartelasAPI = "http://localhost:3460"
	}

	renderAsyncAPI := os.Getenv("RENDER_ASYNC_API")
	if renderAsyncAPI == "" {
		renderAsyncAPI = "http://localhost:3461"
	}

	renderHost := os.Getenv("RENDER_HOST")
	if renderHost == "" {
		renderHost = "http://localhost:3460"
	}

	apiToken := os.Getenv("API_TOKEN")

	port := os.Getenv("PORT")
	if port == "" {
		port = "3470"
	}

	allowedOrigin := os.Getenv("ALLOWED_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:3470"
	}

	// Create DeepSeek LLM client (using DeepSeek V4 Flash)
	llmClient := llmdeepseek.NewLLM(
		llmopenai.WithAPIKey(apiKey),
		llmopenai.WithModel(model.Model{
			ID:       "deepseek-v4-flash",
			APIModel: "deepseek-v4-flash",
		}),
	)

	// Create tools
	vtTool := &GenerateVTTool{CartelasAPI: cartelasAPI, RenderAsyncAPI: renderAsyncAPI, RenderHost: renderHost}
	narrationTool := &GenerateNarrationTool{}
	voicesTool := &ListVoicesTool{CartelasAPI: cartelasAPI}
	ttsTool := &GenerateTTSTool{CartelasAPI: cartelasAPI}
	specsTool := &GetVTSpecsTool{}
	priceTool := &PriceCalculatorTool{}

	// Create session store
	store := session.FileStore("./sessions")

	// Start session cleanup goroutine
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			cleanOldSessions("./sessions", 24*time.Hour)
		}
	}()

	// Wrap handlers with middlewares
	withMiddleware := func(handler http.HandlerFunc) http.HandlerFunc {
		return authMiddleware(apiToken, corsMiddleware(allowedOrigin, handler))
	}

	// HTTP handlers
	http.HandleFunc("/chat", withMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Message string `json:"message"`
			UserID  string `json:"user_id"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
			return
		}

		if req.Message == "" {
			http.Error(w, `{"error":"message is required"}`, http.StatusBadRequest)
			return
		}

		if req.UserID == "" {
			req.UserID = "default"
		}

		// Sanitize input
		req.Message = sanitizeInput(req.Message)

		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()

		// Use user-specific session
		userAgent := agent.New(llmClient,
			agent.WithSystemPrompt(jeanSlimSystemPrompt),
			agent.WithTools(vtTool, narrationTool, voicesTool, ttsTool, specsTool, priceTool),
			agent.WithSession(req.UserID, store),
			agent.WithMaxIterations(10),
		)

		resp, err := userAgent.Chat(ctx, req.Message)
		if err != nil {
			log.Printf("[chat] Error: %v", err)
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"response": resp.Content,
		})
	}))

	// Streaming chat endpoint (SSE)
	http.HandleFunc("/chat-stream", withMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Message string `json:"message"`
			UserID  string `json:"user_id"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
			return
		}

		if req.Message == "" {
			http.Error(w, `{"error":"message is required"}`, http.StatusBadRequest)
			return
		}

		if req.UserID == "" {
			req.UserID = "default"
		}

		// Sanitize input
		req.Message = sanitizeInput(req.Message)

		// Set SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, `{"error":"streaming not supported"}`, http.StatusInternalServerError)
			return
		}

		sendEvent := func(event string, data any) {
			jsonData, _ := json.Marshal(data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, jsonData)
			flusher.Flush()
		}

		// Send start event
		sendEvent("start", map[string]any{"message": "Jean Slim está pensando..."})

		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()

		userAgent := agent.New(llmClient,
			agent.WithSystemPrompt(jeanSlimSystemPrompt),
			agent.WithTools(vtTool, narrationTool, voicesTool, ttsTool, specsTool, priceTool),
			agent.WithSession(req.UserID, store),
			agent.WithMaxIterations(10),
		)

		// Send thinking event
		sendEvent("thinking", map[string]any{"status": "processing"})

		resp, err := userAgent.Chat(ctx, req.Message)
		if err != nil {
			log.Printf("[chat-stream] Error: %v", err)
			sendEvent("error", map[string]any{"error": "internal error"})
			return
		}

		// Send final response (apenas conteúdo, sem vazar métricas internas)
		sendEvent("response", map[string]any{
			"content": resp.Content,
		})

		// Send done event
		sendEvent("done", map[string]any{"status": "complete"})
	}))

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"status": "ok",
			"agent":  "Jean Slim - VT Varejo",
			"llm":    "DeepSeek V4 Flash",
		})
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html>
<html>
<head>
    <title>Jean Slim - VT Varejo AI</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-white min-h-screen">
    <div class="max-w-4xl mx-auto p-6">
        <header class="text-center mb-8">
            <h1 class="text-4xl font-bold text-yellow-400">Jean Slim</h1>
            <p class="text-gray-400">Especialista em VT de Varejo</p>
        </header>
        
        <div id="chat" class="space-y-4 mb-6 h-96 overflow-y-auto bg-gray-800 p-4 rounded-lg">
            <div class="flex justify-start">
                <div class="bg-blue-600 rounded-lg p-3 max-w-xs">
                    <p class="text-sm">Fala! Sou o Jean Slim, especialista em VT de varejo. Como posso te ajudar hoje?</p>
                </div>
            </div>
        </div>
        
        <div class="flex gap-2">
            <input type="text" id="message" placeholder="Digite sua mensagem..." 
                class="flex-1 bg-gray-700 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-yellow-400">
            <button onclick="sendMessage()" 
                class="bg-yellow-500 text-gray-900 px-6 py-3 rounded-lg font-bold hover:bg-yellow-400">
                Enviar
            </button>
        </div>
    </div>
    
    <script>
    async function sendMessage() {
        const input = document.getElementById('message');
        const chat = document.getElementById('chat');
        const message = input.value.trim();
        if (!message) return;
        
        // Add user message
        chat.innerHTML += '<div class="flex justify-end"><div class="bg-gray-600 rounded-lg p-3 max-w-xs"><p class="text-sm">' + message + '</p></div></div>';
        input.value = '';
        
        // Add loading
        chat.innerHTML += '<div id="loading" class="flex justify-start"><div class="bg-blue-600 rounded-lg p-3"><p class="text-sm animate-pulse">Jean Slim está pensando...</p></div></div>';
        chat.scrollTop = chat.scrollHeight;
        
        try {
            const resp = await fetch('/chat', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({message: message, user_id: 'web-user'})
            });
            const data = await resp.json();
            
            document.getElementById('loading').remove();
            chat.innerHTML += '<div class="flex justify-start"><div class="bg-blue-600 rounded-lg p-3 max-w-xs"><p class="text-sm">' + data.response + '</p></div></div>';
        } catch (e) {
            document.getElementById('loading').remove();
            chat.innerHTML += '<div class="flex justify-start"><div class="bg-red-600 rounded-lg p-3 max-w-xs"><p class="text-sm">Erro: ' + e.message + '</p></div></div>';
        }
        
        chat.scrollTop = chat.scrollHeight;
    }
    
    document.getElementById('message').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') sendMessage();
    });
    </script>
</body>
</html>`))
	})

	log.Printf("Jean Slim VT Agent starting on port %s", port)
	log.Printf("DeepSeek API: configured")
	log.Printf("Cartelas API: %s", cartelasAPI)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
