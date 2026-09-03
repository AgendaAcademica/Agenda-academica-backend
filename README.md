# Backend — Agenda Acadêmica

API Node.js/TypeScript que recebe PDFs ou imagens acadêmicas (JPEG, PNG e WebP), envia os arquivos diretamente ao Gemini e devolve disciplina e eventos em JSON estruturado. Os arquivos permanecem somente em memória.

## Deploy no Render

O repositório inclui um Blueprint em `render.yaml`. No painel do Render:

1. Selecione **New > Blueprint** e conecte este repositório.
2. Confirme a criação do serviço `agenda-academica-api`.
3. Informe o segredo `GEMINI_API_KEY` quando solicitado.
4. Aguarde o deploy e confirme que `https://SEU-SERVICO.onrender.com/health` responde com `{"status":"ok"}`.
5. Configure no mobile a URL pública HTTPS do serviço.

O Render fornece `PORT` automaticamente. A API escuta em `0.0.0.0`, compila o TypeScript no build, inicia por `npm start` e usa `/health` no monitoramento.

### Variáveis de ambiente

| Variável | Obrigatória | Padrão | Finalidade |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Sim | — | Chave secreta do Gemini. Cadastre somente no Render. |
| `GEMINI_MODEL` | Não | `gemini-3.5-flash` | Modelo usado na extração. |
| `MAX_PDF_SIZE_MB` | Não | `20` | Limite de tamanho dos documentos. |
| `CORS_ORIGIN` | Não | `*` | Origem permitida. Para clientes web, prefira o domínio exato. |
| `NODE_ENV` | Não | `development` | O Blueprint define `production`. |
| `PORT` | Não | `3000` | Definida automaticamente pelo Render. |

## Desenvolvimento local

Requer Node.js 20 ou superior.

```powershell
npm ci
Copy-Item .env.example .env
# preencha GEMINI_API_KEY no .env
npm run dev
```

## Endpoints

- `GET /health`
- `POST /api/v1/documents/extract`

O endpoint de extração usa `multipart/form-data`: `file` para um PDF ou imagem; ou `files` para até dez imagens da mesma disciplina.

```bash
curl -X POST http://localhost:3000/api/v1/documents/extract -F "file=@plano-de-ensino.pdf"
curl -X POST http://localhost:3000/api/v1/documents/extract -F "files=@pagina-1.png" -F "files=@pagina-2.png"
```

## Validação

```powershell
npm run typecheck
npm test
npm run build
```
