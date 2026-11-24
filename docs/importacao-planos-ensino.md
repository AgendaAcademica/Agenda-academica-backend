# Importação de vários planos de ensino pelo Android

Registro da task **[FEATURE] Validar o suporte da API à importação de vários planos de ensino**, iniciado em **18/11/2026**, sobre a revisão `b576b64`.

## Decisão técnica

**Atualização em 20/11/2026: permitir até 10 documentos por envio.** A rota aceita PDFs e imagens JPEG, PNG ou WebP no mesmo lote, usando `file` ou `files`. A soma dos campos não pode exceder 10. O lote gera uma operação e uma resposta conjunta em `data.disciplines`, mantendo os dados de cada disciplina. O cache considera o conteúdo, MIME e ordem dos arquivos, não seus nomes.

O Android permite selecionar vários PDFs, adicionar imagens e remover arquivos antes do envio. Exibe o aviso **“Você pode enviar no máximo 10 documentos por vez.”** e um contador de selecionados. Se uma nova seleção ultrapassar 10 arquivos distintos, abre um alerta e mantém a seleção anterior. O backend também rejeita o excesso antes da análise com `TOO_MANY_FILES`. A resposta é conjunta, sem resultados ou falhas parciais por arquivo. A importação sequencial continua disponível para clientes que precisem de resultados e retomadas independentes.

**Validação local em 20/11/2026:** `npm test` passou com **90 testes em 9 arquivos**; `npm run typecheck` e `npm run build` também passaram. Os testes HTTP usam o parser multipart e os adaptadores reais com provedor de IA e persistência simulados. A homologação com o app, IA e Firestore reais continua pendente.

No projeto Android, a compilação e **13 testes** de mensagens de erro e revisão de importação passaram (`DocumentAnalysisErrorMessageTest` e `DocumentImportScheduleTest`). Foi necessário fornecer `BuildConfig.GEMINI_API_KEY` vazio por um init script temporário do Gradle, pois o parser legado referencia esse campo ausente na configuração local; isso não adiciona chave ao projeto nem valida o uso desse parser. O alerta no seletor ainda requer verificação visual no dispositivo.

## Ambiente inspecionado

Workspace Linux, Node.js `22.22.3`, npm `10.9.8`. O lockfile fixa Express `5.2.1`, Multer `2.3.0`, Busboy `1.6.0`, SDK Gemini `1.52.0`, Vitest `4.1.11` e TypeScript `5.9.3`. Nenhuma chamada real de IA nem gravação em Firestore foi feita. O `.env` não é versionado; somente os parâmetros de limite foram consultados, sem registrar credenciais.

| Parâmetro | Valor local efetivo pela configuração | Origem |
| --- | --- | --- |
| `MAX_PDF_SIZE_MB` | 20 | `.env` local |
| `MAX_UPLOAD_TOTAL_MB` | 20 | Ausente no `.env` e no processo; padrão do código |
| `MAX_CONCURRENT_EXTRACTIONS` | 2 por processo | Padrão do código |
| `USER_DAILY_REQUESTS` / `GLOBAL_DAILY_REQUESTS` | 20 / 200 | Padrões do código |
| `USER_REQUESTS_PER_MINUTE` | 3 | Padrão do código |
| `USER_DAILY_AI_ATTEMPTS` / `GLOBAL_DAILY_AI_ATTEMPTS` | 40 / 400 | Padrões do código |
| `USER_DAILY_USD` / `GLOBAL_DAILY_USD` | US$ 1 / US$ 10 de custo conhecido | Padrões do código |
| `AI_DOCUMENT_CACHE_TTL_DAYS` | 30 dias | Padrão do código |

Esses são valores resolvidos a partir dos arquivos e das variáveis presentes, não a confirmação de um servidor inicializado. O `render.yaml` também declara 20 MB para ambos os limites, mas não comprova os valores ativos de um deploy. Não foi indicado um ambiente de homologação nesta task.

Os novos testes usam fontes explícitas de configuração, ignorando credenciais e overrides locais: os mesmos limites padrão acima, usuário comum sem isenção e autenticação simulada. O SDK Gemini, o adaptador de extração, o schema, `PersistentAcademicExtractor`, `UsageService`, a rota HTTP e o parser multipart são reais; a rede de IA e os stores de cota/cache são simulados. Isso verifica transporte, isolamento, contrato e contabilização, mas não a qualidade de leitura/OCR de um modelo real nem transações Firestore. O store de cache de teste não simula expiração; esse comportamento possui cobertura separada nos testes de cache existentes.

Para exercitar os bloqueios, cenários específicos reduzem a cota diária ou de tentativas a 1 e o custo a US$ 0,00002. Os testes de fronteira usam 1 KiB e 2 KiB, separando limite por arquivo de limite total. Esses overrides estão no teste e não alteram `.env`, Blueprint ou configuração de produção.

## Contrato para o Android

`POST /api/v1/documents/extract`

- Enviar `Authorization: Bearer <ID token Firebase>`.
- Enviar `multipart/form-data`, repetindo `files` para até 10 PDFs ou imagens; `file` também é aceito. Cada parte deve ter o nome original e o MIME correspondente. A biblioteca HTTP deve gerar o boundary. Não enviar o PDF como JSON/base64, nem usar MIME genérico `application/octet-stream`.
- Não adicionar campos de texto, UID ou e-mail ao formulário. A identidade vem do token verificado.
- PDFs e imagens podem ser combinados no mesmo lote. A resposta reúne todas as disciplinas; páginas da mesma disciplina são consolidadas sem duplicar eventos.
- Ao optar por requisições independentes, aguardar cada resposta e manter o resultado/erro associado ao item local correspondente. Não usar somente o nome como identificador: arquivos distintos podem ter o mesmo nome.

Exemplo de dois PDFs em uma requisição (exige URL e token configurados localmente):

```bash
curl --silent --show-error --include "$BACKEND_URL/api/v1/documents/extract" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -F 'files=@tests/fixtures/algebra-linear.pdf;type=application/pdf' \
  -F 'files=@tests/fixtures/banco-de-dados.pdf;type=application/pdf'
```

HTTP 200 contém `data.disciplines[]` (incluindo `events[]`) e `meta`. O documento pode trazer mais de uma disciplina. Exemplo esperado para a primeira fixture com a rede de IA simulada; o UUID é ilustrativo:

```json
{
  "data": {
    "disciplines": [{
      "documentTitle": "Plano de ensino - Algebra Linear",
      "disciplineName": "Algebra Linear",
      "disciplineCode": "MAT201",
      "professor": "Ada",
      "term": "2026/2",
      "classroom": "",
      "schedule": "",
      "recommendedColorHex": "#2563EB",
      "events": [{
        "title": "Prova de matrizes",
        "date": "2026-12-01",
        "time": "08:00",
        "activityType": "PROVA",
        "priority": "URGENTE",
        "description": "",
        "dueDate": null
      }]
    }]
  },
  "meta": {
    "operationId": "<uuid-da-operacao>",
    "cache": "miss",
    "fileName": "algebra-linear.pdf",
    "fileSize": 768,
    "filesCount": 1,
    "disciplinesCount": 1,
    "eventsCount": 1,
    "mimeType": "application/pdf"
  }
}
```

`operationId` identifica a operação no backend, não é chave de idempotência. Cada nova requisição admitida recebe outro ID, inclusive um cache hit. Em requisições independentes, o sucesso do primeiro item não é desfeito se outro falhar. Em lote, qualquer arquivo inválido rejeita todo o envio antes da análise. As respostas de erro não incluem `meta` nem garantem um `operationId`; conservar a seleção local. Em lotes, `meta.fileName` concatena os nomes, `fileSize` soma os bytes e `filesCount` conta os arquivos; `mimeType` é `multipart/images` quando todos são imagens e `multipart/documents` quando há PDFs.

## Limites de upload e identificação de erros

Os valores chamados de MB são convertidos em bytes por `floor(MB × 1024 × 1024)`: 20 corresponde a **20.971.520 bytes**. `MAX_PDF_SIZE_MB` limita cada arquivo, inclusive imagens. `MAX_UPLOAD_TOTAL_MB` limita a soma dos bytes dos arquivos da requisição, sem contar cabeçalhos e boundaries multipart, e também se aplica a um PDF isolado. A soma não acumula entre requisições.

Com o Multer 2.3.0 instalado, o limite individual é inclusivo, assim como o limite total: ambos rejeitam somente o excesso. Com ambos em 20 MB, cada arquivo e a soma devem ter no máximo **20.971.520 bytes**. Nenhum limite de quantidade de páginas de PDF é imposto pela rota; disponibilidade e capacidade do provedor ainda se aplicam.

Limites do multipart: até 10 arquivos no total, com no máximo 10 partes `file` ou `files`, e zero campos de texto. O limite total também se aplica quando os dois campos são combinados. Preferir `files` para lotes.

O app deve decidir por status HTTP e, quando presente, `code`. `error` é mensagem para exibição; `code` e `retryable` são opcionais no contrato atual. Não depender de comparação de mensagens.

| Situação | HTTP | Corpo esperado |
| --- | --- | --- |
| Sem arquivo | 400 | `{"error":"Envie de 1 a 10 documentos PDF ou imagens nos campos 'file' ou 'files'."}` |
| Mais de 10 arquivos | 400 | `{"error":"Você pode enviar no máximo 10 documentos por vez.","code":"TOO_MANY_FILES","maxFiles":10,"retryable":false}` |
| Campo desconhecido ou campo de texto | 400 | `{"error":"Envio inválido. Use até 10 documentos nos campos file ou files.","code":"INVALID_UPLOAD"}` |
| MIME não suportado ou assinatura incompatível | 415 | `{"error":"O arquivo deve ser um PDF, JPEG, PNG ou WebP válido."}` |
| Limite individual de 20 MB | 413 | `{"error":"O arquivo excede o limite de 20 MB."}` |
| Limite da soma dos arquivos | 413 | `{"error":"O tamanho total dos arquivos excede o limite permitido.","code":"UPLOAD_TOO_LARGE","retryable":false}` |
| Cota local da aplicação | 429 | `{"error":"O limite de uso foi atingido. Aguarde a renovação da cota ou contate o administrador.","code":"<codigo-da-cota>","retryable":<conforme tabela abaixo>}` |
| Concorrência por processo | 429 | `{"error":"Há análises em andamento. Tente novamente em instantes.","code":"SERVER_BUSY","retryable":true}` |
| Mesmo documento já reservado no cache persistente | 429 | `{"error":"Este documento já está sendo analisado. Tente novamente em instantes.","code":"SERVER_BUSY","retryable":true}` |
| Limite do provedor de IA | 429 | `{"error":"O limite temporário de análises foi atingido. Aguarde alguns instantes e tente novamente.","code":"PROVIDER_RATE_LIMIT","retryable":true}` |
| Provedor temporariamente indisponível | 503 | `{"error":"O serviço de inteligência artificial está temporariamente ocupado. Aguarde alguns instantes e tente novamente.","retryable":true}` |

Se mais de um limite de tamanho puder ser atingido, tratar qualquer 413 como falha de tamanho, sem depender de qual mensagem chegou primeiro. Nos testes com limite individual reduzido, a mensagem usa `0.0009765625 MB`, conforme a configuração de 1 KiB.

A mensagem de cota da tabela vem do store de produção `FirestoreUsageStore`. O double `MemoryUsageStore` usado pelos testes existentes e novos retorna **`Muitos envios.`** para `USER_RATE_LIMIT` e **`Cota atingida.`** para cotas diárias, de tentativas e custo. Status, códigos e `retryable` são exercitados no handler real. A mensagem de produção ainda precisa ser observada com Firestore.

A validação de PDF na rota verifica MIME e prefixo `%PDF-`, não toda a estrutura interna. Um arquivo danificado que conserve o prefixo pode passar pelo upload e falhar no provedor, resultando em erro de processamento, não necessariamente 415. HTTP 502 também pode representar saída inválida da IA ou falha genérica de processamento. A autenticação pode retornar 401 (`AUTH_REQUIRED`/`AUTH_INVALID`) ou 503 (`AUTH_UNAVAILABLE`); nesse caso o upload ainda não iniciou uma análise. Falhas de contabilização/cache retornam 503 com códigos próprios e podem ocorrer antes ou depois de chamar a IA.

## Cotas e novas tentativas

| Código HTTP 429 | `retryable` | `Retry-After` | Conduta mobile |
| --- | --- | --- | --- |
| `USER_RATE_LIMIT` | `true` | 60 segundos | Pausar a fila e retomar o item bloqueado |
| `USER_DAILY_QUOTA`, `GLOBAL_DAILY_QUOTA` | `false` | Segundos até a próxima meia-noite UTC | Preservar pendências e informar a renovação; não repetir imediatamente |
| `USER_AI_QUOTA`, `GLOBAL_AI_QUOTA` | `false` | Segundos até a próxima meia-noite UTC | Mesmo tratamento de cota diária |
| `USER_COST_LIMIT`, `GLOBAL_COST_LIMIT` | `false` | Segundos até a próxima meia-noite UTC | Mesmo tratamento de cota diária |
| `SERVER_BUSY` | `true` | 60 segundos | Aguardar e reenviar somente o item pendente |
| `PROVIDER_RATE_LIMIT` | `true` | 30 segundos | Aguardar e reenviar somente o item pendente |

As cotas diárias viram à meia-noite UTC (**20h em Manaus**); o limite por minuto usa janela fixa UTC, não janela móvel de 60 segundos. `Retry-After: 60` é uma espera conservadora. A indisponibilidade HTTP 503 do provedor usa `Retry-After: 30`; outros 503 podem não trazer esse cabeçalho. Respeitar o cabeçalho quando existir e usar espera progressiva com limite de tentativas para falhas temporárias sem ele.

- MIME/assinatura inválidos, tamanho excessivo e multipart inválido são recusados antes de reservar operação: não consomem cota de requisições, minuto ou tentativas de IA.
- Cada envio novo admitido (`cache: miss`), incluindo um lote de até 10 documentos, consome uma requisição diária por usuário e global e uma posição na janela por minuto. Erros após essa reserva não devolvem a cota.
- Cota diária de requisições ou de minuto esgotada bloqueia antes de registrar a operação/chamar a IA. Já a cota de tentativas ou de custo pode bloquear depois de reservar a operação: ela fica com erro e consome a cota de requisições, mas nenhuma tentativa adicional é admitida.
- Uma operação pode chamar o provedor mais de uma vez por retry ou fallback interno. Cada chamada admitida consome uma tentativa, inclusive em falha. Esses retries internos não reservam outra operação; um novo POST do Android reserva. Falhas sem metadados deixam custo desconhecido (`null`), não custo zero.
- Reenviar conteúdo idêntico pode retornar `cache: hit`, mesmo com outro nome ou após esgotar a cota diária. Não gasta nova análise diária nem tentativa de IA, mas registra outra operação e conta no limite por minuto. PDFs corrigidos, reexportados ou resultados expirados/não armazenados podem exigir outra análise.
- Uma reserva existente no cache persistente registra `cache: shared` e retorna `SERVER_BUSY`: conta no limite por minuto, não como nova análise diária. A recusa por concorrência do processo acontece antes de reservar operação e não consome cota.
- Não há garantia de execução exatamente uma vez nem suporte a `Idempotency-Key`. Após perda da resposta ou timeout do cliente, a análise pode ter sido concluída e cobrada. Reenviar somente aquele item; ele pode encontrar cache, análise em andamento ou iniciar outra análise. Preservar os demais sucessos no Android.
- E-mails verificados da lista `UNLIMITED_USER_EMAILS` são isentos das cotas por usuário; as globais continuam ativas. Usar uma conta comum para homologar os bloqueios por usuário. Limites em USD dependem do custo conhecido, não são teto garantido da fatura.

## Evidências e matriz de validação

**Observado em 18/11/2026:** `pdfinfo` reconheceu ambas as fixtures como PDF 1.4, uma página A4, sem criptografia. `pdftotext` confirmou `Algebra Linear (MAT201)` e a prova de matrizes em `2026-12-01 08:00` na primeira, `Banco de Dados (INF202)` e o projeto SQL em `2026-12-05 14:00` na segunda. Tamanhos: 768 e 775 bytes. São documentos sintéticos sem dados pessoais. A simulação do provedor seleciona respostas a partir do conteúdo recebido, e o teste confere os bytes enviados; não depende da ordem de respostas predefinidas nem do nome dos arquivos.

**Registro anterior de 18/11/2026:** a instalação online falhou por rede (`EAI_AGAIN`) e a execução fora do sandbox não foi autorizada. A instalação offline falhou por dependência ausente no cache (`ENOTCACHED`, `zod-4.5.4.tgz`); os testes e o compilador estavam indisponíveis.

**Execução em 20/11/2026:** com as dependências instaladas, os testes HTTP precisaram executar fora do sandbox, que bloqueava portas locais (`listen EPERM`). A suíte completa passou: **90/90 testes**, com a fronteira de tamanho corrigida para o comportamento inclusivo do Multer 2.3.0. Nenhuma chamada paga de IA ou gravação em Firestore foi feita.

Matriz executada em [`tests/document-import.test.ts`](../tests/document-import.test.ts) e [`tests/documents.test.ts`](../tests/documents.test.ts):

| Cenário | Resultado que o teste verifica |
| --- | --- |
| Dois PDFs válidos, mesmo nome, conteúdo diferente | 200 + 200; disciplinas/eventos e bytes independentes, IDs distintos, duas operações e duas tentativas |
| Válido → assinatura inválida → arquivo corrigido | 200 → 415 com mensagem de formato → 200; primeiro resultado preservado, inválido sem consumo |
| PDF com MIME genérico ou texto | 415 com mensagem de formato, sem operação ou IA |
| Dois PDFs / PDF + PNG | 200, disciplinas reunidas, bytes e MIME corretos no provedor simulado; uma operação por lote e cache reutilizado no reenvio |
| Dez PDFs nos campos `file`, `files` ou ambos / onze PDFs | 200 / 400 `TOO_MANY_FILES`, sem consumo e liberando a vaga de processamento |
| Dez PNGs do mesmo plano / onze PNGs | 200 e uma análise conjunta / 400 `TOO_MANY_FILES` sem consumo adicional |
| Arquivo de 1023 / 1024 / 1025 bytes, limite individual 1 KiB | 200 / 200 / 413; arquivo menor pode ser reenviado isoladamente |
| Duas imagens somando 1024 / 1025 bytes, limite total 1 KiB | 200 / 413 `UPLOAD_TOO_LARGE` |
| PDFs isolados com limite total 1 KiB | Três envios consecutivos dentro do limite retornam 200; 1025 bytes retorna 413 sem acumular bytes entre requisições |
| Quatro conteúdos novos no mesmo minuto | 200 × 3, depois 429 `USER_RATE_LIMIT`; reenvio isolado após 60s retorna 200 |
| Cada uma das seis cotas diárias/de tentativas/de custo | Primeiro PDF 200, segundo 429 com código próprio; só o segundo é reenviado com 200 após a virada UTC |
| PDF idêntico renomeado, cota diária esgotada | `miss`, `hit`, `hit`, depois 429 por minuto; apenas uma chamada de IA |
| Falha do provedor 429 ou 503 → retry isolado após 30s | Erro temporário após duas chamadas internas → 200; duas operações `miss`, três tentativas de IA, duas com custo desconhecido |

Para repetir a validação local, instalar as dependências fixadas sem modificar o lockfile e executar:

```bash
npm ci
npm exec -- vitest run tests/document-import.test.ts --reporter=verbose
npm test
npm run typecheck
npm run build
```

A suíte completa também cobre extração de PDF único, PNG, análise conjunta de imagens, retries/fallback dos provedores e cache. Os testes de emulador existentes precisam de Java e das regras Firestore do projeto Mobile, conforme [RELEASE_TEST.md](../RELEASE_TEST.md).

Para a validação de integração real, registrar URL/versão do deploy, data, limites ativos, provedor/modelo e se a conta tem isenção (sem tokens/chaves). Enviar as duas fixtures válidas sequencialmente com uma conta comum, verificar o conteúdo retornado e `operationId`; enviar um PDF inválido e reenviar somente o corrigido; confirmar limites/cotas e os contadores no relatório administrativo. Anexar status, corpo e `Retry-After` observados a esta task. Os doubles locais não comprovam os valores do deploy, as mensagens do Firestore nem a extração semântica da IA real.

Referências de implementação: [rota e validação](../src/routes/documents.routes.ts), [erros HTTP](../src/app.ts), [limite total](../src/routes/upload-storage.ts), [configuração](../src/usage/config.ts), [contabilização](../src/usage/meter.ts), [cotas Firestore](../src/usage/firestore-store.ts), [cache persistente](../src/services/document-cache.ts), [consolidação de disciplinas](../src/services/discipline-consolidation.ts), [controle do plano base](../src/plan/firestore-plan-store.ts).

## Limite de disciplinas no plano base e seleção pós-análise

### Visão geral do fluxo em duas fases (RF04 + RF05)

1. **`POST /api/v1/documents/extract`** processa integralmente os arquivos enviados (até 10 documentos), consolida disciplinas equivalentes por código (`disciplineCode`), nome (`disciplineName`) e período letivo (`term`), deduplica eventos repetidos e persiste internamente a análise pré-confirmação (`backendAnalysisBatches`) antes de qualquer incorporação na agenda (`backendUserDisciplineStates`).
   - A resposta retorna `analysisId` no topo e `meta.operationId`, além de `data` contendo `status: "PENDING_CONFIRMATION"`, `termScope`, `quota` (`limit`, `used`, `remaining`, `isUnlimited`, `term`, `selectionRequired`) e `disciplines[]` com `selectionId`, `disciplineKey`, dados essenciais (`disciplineName`, `disciplineCode`, `term`, `professor`, `classroom`, `schedule`, `parsedSchedule`, `recommendedColorHex`), `consolidation` (incluindo detecção de ambiguidades), `activities` (`hasExtractedActivities`, `totalCount`, `evaluativeCount`, `countsByType`) e `quotaEligibility`.
   - Eventos detalhados (`events[]`) não são incorporados nem liberados na prévia antes da confirmação.
2. **`POST /api/v1/documents/extractions/:analysisId/confirm`** recebe `{ selectedDisciplineIds, ambiguityResolutions? }` e executa uma transação atômica:
   - Valida a seleção contra a cota restante (`BASE_PLAN_DISCIPLINE_LIMIT`, padrão `6`, validada como inteiro positivo na inicialização) por usuário e período letivo.
   - Se a seleção exceder a cota disponível, rejeita com HTTP `422` (`DISCIPLINE_QUOTA_EXCEEDED`) sem aplicar nenhuma disciplina, preservando a análise pendente.
   - Incorpora em `fullDisciplines[]` (com `events[]` completos) apenas as disciplinas selecionadas (e preserva como `FULL` disciplinas já confirmadas como completas anteriormente no mesmo semestre, mesmo que não selecionadas em um reenvio).
   - Incorpora em `essentialOnlyDisciplines[]` (apenas dados essenciais e `events: []`) as demais disciplinas do lote e disciplinas sem atividades extraídas (como comprovantes de matrícula), sem consumir vagas da cota.
   - Permite upgrade posterior de comprovante (`ESSENTIAL_ONLY`) para plano completo (`FULL`) preservando dados essenciais como sala e horário.
   - Garante idempotência para confirmações repetidas com a mesma seleção (`200 OK`) e bloqueio de seleção conflitante após confirmado (`409 ANALYSIS_ALREADY_CONFIRMED`).
3. **`GET /api/v1/documents/extractions/:analysisId`** e **`GET /api/v1/documents/quota?term=YYYY/S`** permitem retomar a prévia/resultado confirmado e consultar a cota utilizada e restante no semestre.

### Erros específicos da seleção e cota

| Situação | HTTP | `code` | `retryable` |
| --- | :---: | --- | :---: |
| Seleção excede a cota disponível do plano base | 422 | `DISCIPLINE_QUOTA_EXCEEDED` | `false` |
| Disciplina selecionada não possui atividades extraídas | 422 | `DISCIPLINE_HAS_NO_ACTIVITIES` | `false` |
| Associação ambígua pendente de revisão (RF05) | 422 | `AMBIGUOUS_DISCIPLINE_REQUIRES_REVIEW` | `false` |
| Payload ou `selectionId` inválido na confirmação | 400 | `INVALID_CONFIRMATION_PAYLOAD` / `INVALID_DISCIPLINE_SELECTION` | `false` |
| JSON malformado no corpo da requisição | 400 | `INVALID_JSON` | `false` |
| Análise inexistente ou expirada | 404 | `ANALYSIS_NOT_FOUND` | `false` |
| Análise pertence a outro usuário | 403 | `ACCESS_DENIED` | `false` |
| Análise já confirmada com seleção diferente | 409 | `ANALYSIS_ALREADY_CONFIRMED` | `false` |
| Armazenamento do plano indisponível | 503 | `PLAN_STORAGE_UNAVAILABLE` | `true` |
