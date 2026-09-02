# Backend — Agenda Acadêmica

API Node.js/TypeScript que recebe PDFs ou imagens acadêmicas (JPEG, PNG e WebP), envia o arquivo diretamente ao Gemini e devolve disciplina e eventos em JSON estruturado. O arquivo fica somente em memória e não é persistido.

## Executar

Requer Node.js 20 ou superior.

```powershell
npm install
Copy-Item .env.example .env
# preencha GEMINI_API_KEY no .env
npm run dev
```

## Endpoint

`POST /api/v1/documents/extract`, usando `multipart/form-data` com um campo `file` contendo um PDF ou imagem.

```bash
curl -X POST http://localhost:3000/api/v1/documents/extract -F "file=@plano-de-ensino.pdf"

# Imagem de cronograma ou aviso acadêmico
curl -X POST http://localhost:3000/api/v1/documents/extract -F "file=@cronograma.png"
```

A resposta contém `data` com o documento, a disciplina e `events`; e `meta` com nome, tamanho e quantidade de eventos. Também há `GET /health`.

O tamanho máximo padrão é 20 MB (configurável até 50 MB). Em produção, configure `CORS_ORIGIN` com as origens permitidas.

```powershell
npm run typecheck
npm test
npm run build
```
