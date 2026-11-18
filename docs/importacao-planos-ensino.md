# Importação de vários planos de ensino pelo Android

Registro da task **[FEATURE] Validar o suporte da API à importação de vários planos de ensino**, iniciado em **18/11/2026**, sobre a revisão `b576b64`.

## Decisão técnica

**Manter uma requisição por PDF.** A rota recebe um documento por operação, e o cache usa conteúdo e MIME, não o nome do arquivo. Não foi encontrada, na inspeção do código, uma limitação que exija lote de PDFs. A principal restrição para uma sequência é a cota padrão de três operações por usuário por minuto; o Android precisa pausar e retomar a fila conforme a resposta.

Não há alteração no contrato de produção nesta task. O campo `files` continua destinado a imagens de páginas do mesmo plano, analisadas em conjunto. Dois PDFs ou PDF acompanhado de imagem continuam sendo rejeitados integralmente. Se uma necessidade futura justificar lote de PDFs, alinhar antes com a task mobile um identificador por arquivo, resultados individuais e regras de cota e retomada.

**Situação da validação:** contrato investigado, fixtures verificadas e testes HTTP adicionados; execução da suíte e homologação real pendentes. As respostas abaixo são expectativas verificadas no código e cobertas pelos testes preparados, **não respostas observadas de uma API em execução**. Não declarar os critérios de aceitação integralmente concluídos até executar os testes e registrar seus resultados.

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
- Enviar `multipart/form-data`, uma parte `file`, com o nome original e MIME `application/pdf`. A biblioteca HTTP deve gerar o boundary. Não enviar o PDF como JSON/base64, nem usar MIME genérico `application/octet-stream`.
- Não adicionar campos de texto, UID ou e-mail ao formulário. A identidade vem do token verificado.
- Para páginas fotografadas do mesmo plano, repetir `files`, com até dez imagens JPEG, PNG ou WebP. Elas geram uma única análise conjunta, não resultados individuais por página.
- Para vários PDFs, aguardar a resposta de cada requisição e manter o resultado/erro associado ao item local correspondente. Não usar somente o nome como identificador: arquivos distintos podem ter o mesmo nome.

Exemplo de duas requisições independentes (exige URL e token configurados localmente):

```bash
curl --silent --show-error --include "$BACKEND_URL/api/v1/documents/extract" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -F 'file=@tests/fixtures/algebra-linear.pdf;type=application/pdf'
curl --silent --show-error --include "$BACKEND_URL/api/v1/documents/extract" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -F 'file=@tests/fixtures/banco-de-dados.pdf;type=application/pdf'
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

`operationId` identifica a operação no backend, não é chave de idempotência. Cada nova requisição admitida recebe outro ID, inclusive um cache hit. O sucesso do primeiro item não é desfeito se outro falhar. As respostas de erro não incluem `meta` nem garantem um `operationId`; conservar o identificador local do item. Em fotos, `meta.fileName` concatena os nomes, `fileSize` soma os bytes e `mimeType` é `multipart/images`.

## Limites de upload e identificação de erros

Os valores chamados de MB são convertidos em bytes por `floor(MB × 1024 × 1024)`: 20 corresponde a **20.971.520 bytes**. `MAX_PDF_SIZE_MB` limita cada arquivo, inclusive imagens. `MAX_UPLOAD_TOTAL_MB` limita a soma dos bytes dos arquivos da requisição, sem contar cabeçalhos e boundaries multipart, e também se aplica a um PDF isolado. A soma não acumula entre requisições.

Os testes de fronteira preparados verificam que o parser rejeita um arquivo ao atingir o limite individual, enquanto o storage total rejeita somente a soma que ultrapassa seu limite. Até confirmar isso na execução com as dependências fixadas, o Android deve enviar arquivos estritamente abaixo do limite individual e respeitar o limite total. Com ambos em 20 MB, usar PDF de no máximo **20.971.519 bytes**. Nenhum limite de quantidade de páginas de PDF é imposto pela rota; disponibilidade e capacidade do provedor ainda se aplicam.

Limites do multipart: até dez arquivos no total, `file` no máximo uma vez, `files` no máximo dez vezes e zero campos de texto. Mais de um arquivo exige que todos sejam imagens. Preferir um único campo por modalidade de envio; não combinar `file` e `files` no cliente.

O app deve decidir por status HTTP e, quando presente, `code`. `error` é mensagem para exibição; `code` e `retryable` são opcionais no contrato atual. Não depender de comparação de mensagens.

| Situação | HTTP | Corpo esperado |
| --- | --- | --- |
| Sem arquivo | 400 | `{"error":"Envie um PDF ou imagem no campo 'file'."}` |
| Mais de dez arquivos, campo desconhecido ou campo de texto | 400 | `{"error":"Envio inválido. Use até dez arquivos nos campos file ou files.","code":"INVALID_UPLOAD"}` |
| MIME não suportado ou assinatura incompatível | 415 | `{"error":"O arquivo deve ser um PDF, JPEG, PNG ou WebP válido."}` |
| Dois PDFs ou PDF + imagem com MIME/assinaturas válidos | 415 | `{"error":"O envio múltiplo aceita somente imagens."}` |
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
- Cada documento novo admitido (`cache: miss`) consome uma requisição diária por usuário e global e uma posição na janela por minuto. Erros após essa reserva não devolvem a cota.
- Cota diária de requisições ou de minuto esgotada bloqueia antes de registrar a operação/chamar a IA. Já a cota de tentativas ou de custo pode bloquear depois de reservar a operação: ela fica com erro e consome a cota de requisições, mas nenhuma tentativa adicional é admitida.
- Uma operação pode chamar o provedor mais de uma vez por retry ou fallback interno. Cada chamada admitida consome uma tentativa, inclusive em falha. Esses retries internos não reservam outra operação; um novo POST do Android reserva. Falhas sem metadados deixam custo desconhecido (`null`), não custo zero.
- Reenviar conteúdo idêntico pode retornar `cache: hit`, mesmo com outro nome ou após esgotar a cota diária. Não gasta nova análise diária nem tentativa de IA, mas registra outra operação e conta no limite por minuto. PDFs corrigidos, reexportados ou resultados expirados/não armazenados podem exigir outra análise.
- Uma reserva existente no cache persistente registra `cache: shared` e retorna `SERVER_BUSY`: conta no limite por minuto, não como nova análise diária. A recusa por concorrência do processo acontece antes de reservar operação e não consome cota.
- Não há garantia de execução exatamente uma vez nem suporte a `Idempotency-Key`. Após perda da resposta ou timeout do cliente, a análise pode ter sido concluída e cobrada. Reenviar somente aquele item; ele pode encontrar cache, análise em andamento ou iniciar outra análise. Preservar os demais sucessos no Android.
- E-mails verificados da lista `UNLIMITED_USER_EMAILS` são isentos das cotas por usuário; as globais continuam ativas. Usar uma conta comum para homologar os bloqueios por usuário. Limites em USD dependem do custo conhecido, não são teto garantido da fatura.

## Evidências e matriz de validação

**Observado em 18/11/2026:** `pdfinfo` reconheceu ambas as fixtures como PDF 1.4, uma página A4, sem criptografia. `pdftotext` confirmou `Algebra Linear (MAT201)` e a prova de matrizes em `2026-12-01 08:00` na primeira, `Banco de Dados (INF202)` e o projeto SQL em `2026-12-05 14:00` na segunda. Tamanhos: 768 e 775 bytes. São documentos sintéticos sem dados pessoais. A simulação do provedor seleciona respostas a partir do conteúdo recebido, e o teste confere os bytes enviados; não depende da ordem de respostas predefinidas nem do nome dos arquivos.

**Observado na execução de comandos:** a instalação online falhou por rede (`EAI_AGAIN`) e a execução fora do sandbox não foi autorizada. A instalação offline falhou por dependência ausente no cache (`ENOTCACHED`, `zod-4.5.4.tgz`). `npm test -- --reporter=verbose` terminou com `vitest: not found`; `npm run typecheck` e `npm run build` terminaram com `tsc: not found`. `node --experimental-strip-types --check tests/document-import.test.ts` passou na checagem de sintaxe; isso não substitui typecheck ou testes.

Matriz preparada em [`tests/document-import.test.ts`](../tests/document-import.test.ts). **Todos os cenários HTTP abaixo estão pendentes de execução**:

| Cenário | Resultado que o teste verifica |
| --- | --- |
| Dois PDFs válidos, mesmo nome, conteúdo diferente | 200 + 200; disciplinas/eventos e bytes independentes, IDs distintos, duas operações e duas tentativas |
| Válido → assinatura inválida → arquivo corrigido | 200 → 415 com mensagem de formato → 200; primeiro resultado preservado, inválido sem consumo |
| PDF com MIME genérico ou texto | 415 com mensagem de formato, sem operação ou IA |
| Dois PDFs / PDF + PNG | 415 `O envio múltiplo aceita somente imagens.`, sem operação ou IA |
| Dez PNGs do mesmo plano / onze PNGs | 200 e uma análise conjunta / 400 `INVALID_UPLOAD` sem consumo adicional |
| Arquivo de 1023 / 1024 / 1025 bytes, limite individual 1 KiB | 200 / 413 / 413; arquivo menor pode ser reenviado isoladamente |
| Duas imagens somando 1024 / 1025 bytes, limite total 1 KiB | 200 / 413 `UPLOAD_TOO_LARGE` |
| PDFs isolados com limite total 1 KiB | Três envios consecutivos dentro do limite retornam 200; 1025 bytes retorna 413 sem acumular bytes entre requisições |
| Quatro conteúdos novos no mesmo minuto | 200 × 3, depois 429 `USER_RATE_LIMIT`; reenvio isolado após 60s retorna 200 |
| Cada uma das seis cotas diárias/de tentativas/de custo | Primeiro PDF 200, segundo 429 com código próprio; só o segundo é reenviado com 200 após a virada UTC |
| PDF idêntico renomeado, cota diária esgotada | `miss`, `hit`, `hit`, depois 429 por minuto; apenas uma chamada de IA |
| Falha do provedor 429 ou 503 → retry isolado após 30s | Erro temporário após duas chamadas internas → 200; duas operações `miss`, três tentativas de IA, duas com custo desconhecido |

Para concluir a validação local, instalar as dependências fixadas sem modificar o lockfile e executar:

```bash
npm ci
npm exec -- vitest run tests/document-import.test.ts --reporter=verbose
npm test
npm run typecheck
npm run build
```

Depois, atualizar esta seção com a saída observada e o total de testes aprovados. A suíte completa também cobre extração de PDF único, PNG, análise conjunta de imagens, retries/fallback dos provedores e cache. Os testes de emulador existentes precisam de Java e das regras Firestore do projeto Mobile, conforme [RELEASE_TEST.md](../RELEASE_TEST.md).

Para a validação de integração real, registrar URL/versão do deploy, data, limites ativos, provedor/modelo e se a conta tem isenção (sem tokens/chaves). Enviar as duas fixtures válidas sequencialmente com uma conta comum, verificar o conteúdo retornado e `operationId`; enviar um PDF inválido e reenviar somente o corrigido; confirmar limites/cotas e os contadores no relatório administrativo. Anexar status, corpo e `Retry-After` observados a esta task. Os doubles locais não comprovam os valores do deploy, as mensagens do Firestore nem a extração semântica da IA real.

Referências de implementação: [rota e validação](../src/routes/documents.routes.ts), [erros HTTP](../src/app.ts), [limite total](../src/routes/upload-storage.ts), [configuração](../src/usage/config.ts), [contabilização](../src/usage/meter.ts), [cotas Firestore](../src/usage/firestore-store.ts), [cache persistente](../src/services/document-cache.ts).
