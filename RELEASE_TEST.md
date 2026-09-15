# Release de testes com consumo por usuário

## O que foi implementado

- Token Firebase obrigatório no backend, com validação de revogação/conta desativada antes do upload.
- Lista de testadores por UID e lista administrativa separada. Lista vazia não libera ninguém.
- Registros persistentes no Firestore antes e depois de cada chamada à IA, incluindo retries e fallback.
- Tokens de entrada, entrada em cache do provedor, saída e raciocínio; tarifa e versão utilizadas; custo estimado em USD.
- Resultado de cache local marcado como `hit`; chamada em andamento compartilhada marcada como `shared`. O custo da chamada pertence ao usuário que a iniciou.
- Cotas transacionais de requisições e tentativas, por usuário e globais. Limite por minuto por usuário.
- Limite de tamanho total do upload aplicado durante a leitura e concorrência por processo.
- Relatório administrativo JSON detalhado e CSV agregado por usuário.

## Configuração antes de publicar

1. Confirmar o projeto `agendaacademicabd`, a edição e o banco usados pelo aplicativo. O CLI local estava sem login durante a implementação. Nenhum banco remoto foi criado, consultado com sucesso ou alterado. O adaptador usa a API Core/Native do Firestore; os testes locais usam emulador e não comprovam a configuração remota.

   ```powershell
   npx -y firebase-tools@latest login
   npx -y firebase-tools@latest firestore:databases:list --project agendaacademicabd
   npx -y firebase-tools@latest firestore:databases:get '(default)' --project agendaacademicabd
   ```

2. Configurar credenciais do Firebase Admin **somente no backend**: `GOOGLE_APPLICATION_CREDENTIALS` apontando para um arquivo local protegido ou `FIREBASE_SERVICE_ACCOUNT_JSON` como segredo no Render. A conta de serviço precisa ler usuários do Firebase Authentication e executar leituras/transações do Firestore. Não usar `google-services.json` do Android como credencial Admin.

3. As contas aprovadas para administrador e testador inicial foram registradas em `RELEASE_ADMIN_EMAILS` e `RELEASE_TESTER_EMAILS` no `.env` local, ignorado pelo Git. Ambas precisam existir no Firebase Authentication. Resolver os UIDs com:

   ```powershell
   npm run resolve:accounts
   ```

   Esse comando é somente leitura, não envia e-mails e não cria usuários. Copiar os valores `ADMIN_UIDS` e `TESTER_UIDS` para os segredos/variáveis do Render e para o `.env` local. O administrador não ganha acesso à extração automaticamente; para isso, seu UID também precisaria entrar em `TESTER_UIDS`.

4. Preencher `AI_PRICES_JSON` com as tarifas reais da conta, em USD por milhão de tokens, para **todos** os modelos ativos, inclusive fallback. A aplicação bloqueia a inicialização em produção quando faltam tarifas ou listas de acesso. Não foram inventados preços nem assumido plano gratuito.

   Estrutura de cada entrada: chave `gemini:NOME_DO_MODELO` ou `openai:NOME_DO_MODELO`, valor com `version` (identificador/data da tarifa), `inputUsdPerMillion`, `cachedInputUsdPerMillion` e `outputUsdPerMillion` (números não negativos). Exemplo apenas de formato em `.env.example`; nenhum valor de exemplo deve ser interpretado como preço real.

   Conferir [preços Gemini](https://ai.google.dev/gemini-api/docs/pricing) e [preços OpenAI](https://developers.openai.com/api/docs/pricing), considerando o plano, modalidade e eventuais faixas de contexto. A tabela atual suporta uma tarifa por modelo, não tabelas progressivas por faixa. Se o plano aplicar preços diferentes por tamanho de contexto, adaptar a tabela antes de usar esse modelo no teste.

5. Conferir as regras efetivamente publicadas no Firestore. As regras atuais de `Mobile/firestore.rules` já negam por padrão as novas coleções abaixo. Não é necessário conceder acesso direto a elas ao aplicativo. O Admin SDK usa IAM e não depende de permissões de cliente nessas regras. Evitar publicar outras alterações de regras sem revisão.

6. Publicar backend e aplicativo compatíveis na mesma janela de teste. Versões antigas do app que não enviam token passam a receber HTTP 401. O blueprint do Render contém as novas variáveis; não houve deploy nem geração de APK assinado nesta implementação.

## Dados e contabilização

| Coleção | Conteúdo |
| --- | --- |
| `backendUsageOperations` | UID, data, tamanho/quantidade de arquivos, status da importação, duração e cache. |
| `backendUsageAttempts` | Uma entrada por chamada ao SDK, UID iniciador, operação, provedor, modelo solicitado/retornado, tokens, tarifa, custo e identificador do provedor. |
| `backendUsageQuotas` | Contadores diários UTC, janela de minuto e custo conhecido, atualizados em transações. |

Arquivos, prompts, resposta textual da IA, senhas e tokens de autenticação não são armazenados nesses registros. A telemetria antiga `users/{uid}/aiUsage` é enviada pelo cliente e não é fonte dos custos do backend.

Cada tentativa é reservada como `pending` antes de enviar o documento ao provedor. O consumo retornado é salvo antes de validar o JSON, pois uma resposta inválida também pode consumir IA. A conclusão é idempotente: repeti-la não soma o gasto novamente.

Falha de gravação bloqueia a análise; não há fallback para armazenamento em memória. Em uma interrupção após a chamada mas antes da gravação, o registro fica pendente. Custo ausente é `null`, inclusive em falhas sem metadados, e aparece em `unknownCostAttempts`; não é tratado como chamada gratuita. O relatório soma somente custos conhecidos. Conferir pendências e custos desconhecidos com os registros/fatura do provedor; a conciliação não é automática.

O cache de documentos continua em memória e se perde ao reiniciar ou variar a instância. O histórico e as cotas persistem no banco. Em compartilhamento entre usuários, o segundo usuário pode ter uma importação bem-sucedida sem nenhuma chamada cobrada à IA; isso é esperado. O CSV mostra essa distinção.

## Limites iniciais configuráveis

| Variável | Padrão |
| --- | --- |
| `USER_DAILY_REQUESTS` / `GLOBAL_DAILY_REQUESTS` | 20 / 200 |
| `USER_REQUESTS_PER_MINUTE` | 3 (janela fixa UTC) |
| `USER_DAILY_AI_ATTEMPTS` / `GLOBAL_DAILY_AI_ATTEMPTS` | 40 / 400 |
| `USER_DAILY_USD` / `GLOBAL_DAILY_USD` | US$ 1 / US$ 10 |
| `MAX_UPLOAD_TOTAL_MB` | 20 MB por envio, até 10 arquivos |
| `MAX_CONCURRENT_EXTRACTIONS` | 2 por processo |

Requisições válidas contam mesmo quando o resultado vem do cache ou a IA falha. Retries/fallback consomem a cota de tentativas, sem consumir outra cota de requisição. As cotas são compartilhadas por todas as instâncias do mesmo banco e viram à meia-noite UTC. Os limites de concorrência e cache são locais a cada processo.

**Limites em USD são bloqueios baseados no custo conhecido, não garantias de teto da fatura.** Uma chamada já iniciada pode ultrapassar o valor restante; chamadas paralelas e custos desconhecidos podem aumentar essa diferença. As cotas de quantidade continuam limitando admissões atomicamente. Para testar um teto monetário estrito seria necessária reserva conservadora de orçamento antes da chamada e conciliação do consumo desconhecido. Configure também os controles disponíveis na conta do provedor. Hospedagem, Firestore, impostos, câmbio e créditos não entram neste custo estimado de IA.

## Consultar o relatório

Autenticar com o **ID token Firebase do administrador**, não uma API key nem token do CLI:

```powershell
# ADMIN_ID_TOKEN e BACKEND_URL são variáveis locais já configuradas; não registrar o token em logs.
$headers = @{ Authorization = "Bearer $env:ADMIN_ID_TOKEN" }
Invoke-RestMethod -Uri "$env:BACKEND_URL/api/v1/admin/usage?from=2026-09-14&to=2026-09-14" -Headers $headers
Invoke-WebRequest -Uri "$env:BACKEND_URL/api/v1/admin/usage?from=2026-09-14&to=2026-09-14&format=csv" -Headers $headers -OutFile consumo.csv
```

`from` e `to` são inclusivos, no formato YYYY-MM-DD e em UTC, com até 31 dias. O JSON contém operações, tentativas e totais por UID. O CSV contém os totais e protege identificadores contra fórmulas de planilha. Se o período ultrapassar 10.000 registros de operações ou tentativas, o endpoint retorna 422 solicitando um intervalo menor; não corta totais silenciosamente. Datas da operação e da tentativa são independentes, então uma tentativa após a meia-noite entra no dia em que foi iniciada.

## Validação

Validado localmente em 14/09/2026: typecheck e build do backend, 32 testes unitários/HTTP, 4 testes de integração com emuladores Auth/Firestore e 3 testes Android do interceptor; compilação Kotlin aprovada. `npm audit` retornou zero vulnerabilidades após a atualização transitiva de `uuid` usada pelo `gaxios` (override mantém a versão CommonJS compatível). A consulta real de UIDs foi tentada e retornou `app/invalid-credential`; a ativação remota continua pendente de credenciais Admin e tarifas.

```powershell
npm run typecheck
npm test
npm run build
# Requer Java 21+ e o projeto Mobile ao lado do Backend; usa somente demo-agenda-usage.
powershell -File scripts/test-emulators.ps1
```

Os testes unitários simulam somente a rede dos provedores, sem gastar créditos. Os testes de emulador verificam concorrência transacional, persistência ao recriar o adaptador, liquidação idempotente, validação de token/conta desativada e negação de leitura/escrita por clientes nas coleções do backend. `npm test` exclui `dist` e os testes que exigem emulador.

Antes de distribuir a release: importar um documento pequeno com o testador aprovado, conferir UID/tokens/custo no relatório administrativo, repetir o mesmo arquivo para conferir o cache, reiniciar o backend e verificar que o histórico permanece. Conferir também HTTP 401 sem token e 403 com uma conta fora da lista. Essa etapa real depende das credenciais e tarifas; não é substituída pelos testes locais.

Referências de contabilização: [tokens Gemini, incluindo raciocínio](https://ai.google.dev/gemini-api/docs/generate-content/tokens), [tokens de raciocínio OpenAI](https://developers.openai.com/api/docs/guides/reasoning) e [verificação de ID tokens Firebase](https://firebase.google.com/docs/auth/admin/verify-id-tokens).
