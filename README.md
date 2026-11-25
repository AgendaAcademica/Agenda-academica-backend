# Backend — Agenda Acadêmica

API Node.js/TypeScript que recebe PDFs ou imagens acadêmicas (JPEG, PNG e WebP), processa com Gemini ou OpenAI e devolve disciplina e eventos em JSON estruturado. Os arquivos permanecem somente em memória. Resultados repetidos são mantidos em cache temporário pelo hash do conteúdo.

A extração aceita qualquer usuário autenticado com ID token Firebase válido, sem aprovação manual por UID. Consumo e cotas são registrados pelo backend no Firestore. E-mails verificados em `UNLIMITED_USER_EMAILS` ficam isentos das cotas por usuário; limites globais, do provedor e de upload continuam aplicáveis. Consulte [RELEASE_TEST.md](RELEASE_TEST.md) para configurar credenciais Admin, usuários, preços e consultar o relatório. A configuração abaixo de IA é apenas parte dos requisitos de deploy.

## Deploy no Render

O repositório inclui um Blueprint em `render.yaml`. No painel do Render:

1. Selecione **New > Blueprint** e conecte este repositório.
2. Confirme a criação do serviço `agenda-academica-api`.
3. Informe `GEMINI_API_KEY`, as credenciais Firebase Admin, os UIDs autorizados e as tarifas conforme `RELEASE_TEST.md`.
4. Aguarde o deploy e confirme que `https://SEU-SERVICO.onrender.com/health` responde com `status: "ok"` e informa o provedor, o modelo, o fallback e se a credencial principal foi configurada.
5. Configure no mobile a URL pública HTTPS do serviço.

O Render fornece `PORT` automaticamente. A API escuta em `0.0.0.0`, compila o TypeScript no build, inicia por `npm start` e usa `/health` no monitoramento.

### Variáveis de ambiente

| Variável | Obrigatória | Padrão | Finalidade |
| --- | --- | --- | --- |
| `AI_PROVIDER` | Não | `gemini` | Provedor principal: `gemini` ou `openai`. |
| `AI_FALLBACK_PROVIDER` | Não | `none` | Alternativo para indisponibilidade temporária: `none`, `gemini` ou `openai`. |
| `GEMINI_API_KEY` | Se usar Gemini | — | Chave secreta do Gemini. Cadastre somente no backend. |
| `GEMINI_MODEL` | Não | `gemini-3.5-flash` | Modelo usado na extração. |
| `GEMINI_FALLBACK_MODEL` | Não | `gemini-3.5-flash-lite` | Modelo Gemini alternativo. |
| `OPENAI_API_KEY` | Se usar OpenAI | — | Chave secreta da OpenAI. Cadastre somente no backend. |
| `OPENAI_MODEL` | Não | `gpt-5-mini` | Modelo OpenAI usado na extração. |
| `FIREBASE_PROJECT_ID` | Sim | — | Projeto usado para validar tokens e registrar consumo/cache. |
| `FIRESTORE_DATABASE_ID` | Não | `(default)` | Banco Firestore usado pelo backend. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Localmente | — | Caminho para a conta de serviço Firebase Admin. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | No Render | — | JSON completo da conta de serviço, armazenado como segredo. |
| `UNLIMITED_USER_EMAILS` | Não | Vazia | E-mails verificados isentos das cotas por usuário, separados por vírgula. Limites globais continuam ativos. |
| `ADMIN_UIDS` | Sim em produção | — | UIDs autorizados a consultar o relatório, separados por vírgula. |
| `AI_PRICES_JSON` | Sim em produção | `{}` | Tarifas dos modelos ativos; formato detalhado em `RELEASE_TEST.md`. |
| `AI_DOCUMENT_CACHE_TTL_DAYS` | Não | `30` | Validade do JSON extraído no cache persistente Firestore, compartilhado entre usuários autorizados. |
| `AI_CACHE_TTL_MINUTES` | Não | `1440` | Duração do adaptador de cache em memória, usado somente sem store persistente. |
| `AI_CACHE_MAX_ENTRIES` | Não | `100` | Quantidade máxima de análises no cache. |
| `MAX_PDF_SIZE_MB` | Não | `20` | Limite de tamanho dos documentos. |
| `MAX_UPLOAD_TOTAL_MB` | Não | `20` | Limite total por envio, considerando até dez arquivos. |
| `MAX_CONCURRENT_EXTRACTIONS` | Não | `2` | Extrações simultâneas por processo. |
| `USER_DAILY_REQUESTS` / `GLOBAL_DAILY_REQUESTS` | Não | `20` / `200` | Cotas diárias de novas análises. |
| `USER_REQUESTS_PER_MINUTE` | Não | `3` | Limite por usuário em janela fixa UTC. |
| `USER_DAILY_AI_ATTEMPTS` / `GLOBAL_DAILY_AI_ATTEMPTS` | Não | `40` / `400` | Cotas diárias de chamadas aos provedores, incluindo retries/fallback. |
| `USER_DAILY_USD` / `GLOBAL_DAILY_USD` | Não | `1` / `10` | Bloqueios por custo conhecido estimado em USD. |
| `CORS_ORIGIN` | Não | `*` | Origem permitida. Para clientes web, prefira o domínio exato. |
| `NODE_ENV` | Não | `development` | O Blueprint define `production`. |
| `PORT` | Não | `3000` | Definida automaticamente pelo Render. |

## Desenvolvimento local

Para o passo a passo no Windows/PowerShell, incluindo configuração do `.env` e solução de erros de Node.js/npm, consulte [EXECUTAR_BACKEND.md](EXECUTAR_BACKEND.md).

Requer Node.js 20 ou superior.

```powershell
npm ci
Copy-Item .env.example .env
# escolha AI_PROVIDER, preencha a chave correspondente, as credenciais Firebase
# Admin, ADMIN_UIDS, UNLIMITED_USER_EMAILS (opcional) e as tarifas dos modelos ativos
npm run dev
```

Para usar OpenAI como principal e Gemini quando houver indisponibilidade temporária:

```dotenv
AI_PROVIDER=openai
AI_FALLBACK_PROVIDER=gemini
OPENAI_API_KEY=sua_chave_da_openai
GEMINI_API_KEY=sua_chave_do_gemini
```

Enquanto a OpenAI estiver inativa, mantenha `AI_PROVIDER=gemini` e `AI_FALLBACK_PROVIDER=none`. A integração e a chave opcional podem permanecer configuradas para uma ativação futura; nessas condições, nenhuma requisição é enviada à OpenAI.

## Endpoints

- `GET /health`
- `POST /api/v1/documents/extract`
- `GET /api/v1/admin/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv` (ID token de administrador)

O endpoint de extração usa `multipart/form-data` e aceita de 1 a 10 documentos por envio, entre PDFs e imagens JPEG, PNG ou WebP, inclusive misturados. Repita o campo `files` para múltiplos documentos; `file` também é aceito. O limite de 10 considera a soma dos dois campos.

Os arquivos são analisados juntos, com as disciplinas retornadas em `data.disciplines`. Acima de 10, a API retorna HTTP 400 com código `TOO_MANY_FILES` e o aviso **“Você pode enviar no máximo 10 documentos por vez.”**, sem iniciar a análise. Os limites de tamanho por arquivo e por envio continuam aplicáveis. O [contrato de importação para o Android](docs/importacao-planos-ensino.md) detalha limites, cotas e tratamento de erros.

```bash
curl -X POST http://localhost:3000/api/v1/documents/extract -H "Authorization: Bearer $FIREBASE_ID_TOKEN" -F "file=@plano-de-ensino.pdf"
curl -X POST http://localhost:3000/api/v1/documents/extract -H "Authorization: Bearer $FIREBASE_ID_TOKEN" -F "files=@plano-calculo.pdf" -F "files=@plano-fisica.pdf"
curl -X POST http://localhost:3000/api/v1/documents/extract -H "Authorization: Bearer $FIREBASE_ID_TOKEN" -F "files=@pagina-1.png" -F "files=@pagina-2.png"
```

## Validação

```powershell
npm run typecheck
npm test
npm run build
```
