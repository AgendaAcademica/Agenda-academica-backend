# Como executar o backend no Windows

Este guia usa o PowerShell, inclusive o terminal integrado do editor. Execute cada comando em uma linha separada, sem copiar o texto `PS C:\...>` que aparece antes dos comandos no terminal.

## 1. Verificar o Node.js e o npm

O projeto exige Node.js 20 ou superior. Se ainda não estiver instalado, use o instalador LTS do [site oficial do Node.js](https://nodejs.org/en/download), incluindo o npm, e depois feche completamente e reabra o editor.

Confira a instalação:

```powershell
node --version
npm.cmd --version
```

Os dois comandos devem mostrar suas versões. Neste guia usamos `npm.cmd` para evitar bloqueios do script `npm.ps1` no PowerShell.

Se o Node.js foi instalado em `C:\Program Files\nodejs`, mas o terminal ainda não encontra os comandos, atualize o PATH da sessão atual:

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"
node --version
npm.cmd --version
```

Esse ajuste vale apenas para o terminal atual. Se o instalador já adicionou o Node.js ao PATH do Windows, fechar todas as janelas do editor e abri-lo novamente atualiza os próximos terminais.

## 2. Entrar na pasta do backend

```powershell
Set-Location "C:\Users\silva\Documents\agendaAcademica\Agenda-academica-backend"
Get-Item package.json, package-lock.json
```

Os dois arquivos devem existir. Execute os próximos comandos nessa pasta. Se o terminal estiver em `C:\WINDOWS\System32`, primeiro entre na pasta acima.

## 3. Instalar as dependências

```powershell
npm.cmd ci
```

Aguarde o comando terminar. Ele instala as versões registradas no `package-lock.json` e recria a pasta `node_modules`, caso ela já exista. Faça isso na primeira execução e quando as dependências do projeto forem atualizadas.

## 4. Configurar o arquivo .env

Crie o arquivo somente se ele ainda não existir, preservando a configuração atual:

```powershell
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
}
notepad .env
```

Para desenvolvimento local com Gemini, configure estes campos no `.env`, substituindo os exemplos pelas suas informações:

```dotenv
NODE_ENV=development
PORT=3000
AI_PROVIDER=gemini
AI_FALLBACK_PROVIDER=none
GEMINI_API_KEY=SUA_CHAVE_REAL_DO_GEMINI
FIREBASE_PROJECT_ID=ID_DO_SEU_PROJETO_FIREBASE
FIRESTORE_DATABASE_ID=(default)
GOOGLE_APPLICATION_CREDENTIALS=C:/caminho/privado/service-account.json
UNLIMITED_USER_EMAILS=
ADMIN_UIDS=UID_DO_ADMINISTRADOR
AI_PRICES_JSON={}
```

- Mantenha as demais opções do `.env.example`, incluindo os modelos e os limites de uso.
- O arquivo indicado em `GOOGLE_APPLICATION_CREDENTIALS` deve existir e conter uma conta de serviço com as permissões necessárias para o Firebase Authentication e o banco Firestore usados pelo backend. Use barras `/` no caminho, como no exemplo.
- Se `FIREBASE_SERVICE_ACCOUNT_JSON` já estiver configurado, o backend prioriza essa credencial. Use uma das formas de credencial de maneira consistente.
- Qualquer usuário autenticado no Firebase do projeto pode analisar documentos, sem aprovação manual por UID. A extração continua exigindo um ID token Firebase válido, inclusive em desenvolvimento. `TESTER_UIDS` deixou de ser utilizado.
- Para isentar integrantes da equipe das cotas por usuário, configure `UNLIMITED_USER_EMAILS=email1@exemplo.com,email2@exemplo.com`. A lista é opcional, não diferencia maiúsculas e minúsculas e exige e-mail verificado no token Firebase. A isenção cobre requisições por dia/minuto, tentativas de IA e custo por usuário. Limites globais, concorrência, arquivos e limites dos provedores continuam ativos; o consumo continua registrado. Após verificar o e-mail, entre novamente no app para atualizar o token.
- `ADMIN_UIDS` autoriza a consulta do relatório de consumo. Pode ficar vazio localmente se você não for usar esse relatório.
- `AI_PRICES_JSON={}` é aceito em desenvolvimento, mas deixa o custo desconhecido. Em produção, as tarifas dos modelos ativos e a lista `ADMIN_UIDS` são obrigatórias.

Não coloque credenciais Admin no app mobile nem versione o `.env` ou a chave da conta de serviço. Consulte [RELEASE_TEST.md](RELEASE_TEST.md) para os detalhes de credenciais, autorização, tarifas e relatórios.

Salve o `.env` antes de continuar. Reinicie o servidor sempre que alterar essas variáveis.

### 4.1. Configurar os e-mails dos testers da equipe

Qualquer usuário autenticado já pode testar a análise de documentos. Para deixar os testers da equipe **sem as cotas por usuário**, adicione seus e-mails à variável `UNLIMITED_USER_EMAILS` do backend. Não é necessário procurar UIDs nem preencher `TESTER_UIDS`.

1. Na pasta do backend, abra o arquivo de configuração:

   ```powershell
   notepad .env
   ```

2. Localize `UNLIMITED_USER_EMAILS`. Se a linha não existir, adicione-a. Para uma conta, use:

   ```dotenv
   UNLIMITED_USER_EMAILS=seu-email@exemplo.com
   ```

   Para vários testers, mantenha todos os e-mails na mesma linha, separados por vírgula:

   ```dotenv
   UNLIMITED_USER_EMAILS=seu-email@exemplo.com,tester2@exemplo.com,tester3@exemplo.com
   ```

   Substitua os exemplos pelos e-mails usados para entrar no aplicativo. Edite a linha existente, sem criar várias linhas com a mesma variável. Uma lista vazia mantém as cotas normais para todos.

3. Confira se cada conta existe no Firebase Authentication e tem o e-mail verificado. A isenção exige `email_verified=true` no ID token Firebase; apenas adicionar o endereço à lista não verifica a conta. Depois de concluir a verificação do e-mail, saia e entre novamente no app para atualizar o token.

4. Salve o `.env`. No terminal do servidor, pressione **Ctrl+C** e execute novamente:

   ```powershell
   npm.cmd run dev
   ```

5. Teste uma análise no aplicativo com a conta configurada. Se o backend estiver hospedado no Render, configure `UNLIMITED_USER_EMAILS` nas variáveis de ambiente do serviço e aplique a alteração com reinicialização/redeploy. Alterar o `.env` do computador afeta somente a execução local.

A isenção remove os limites de requisições diárias, requisições por minuto, tentativas de IA e custo diário **por usuário**. Os limites globais, dos provedores, de tamanho dos arquivos e de concorrência continuam ativos. O consumo permanece registrado, e a lista não concede acesso aos relatórios administrativos.

Para retirar a isenção de um tester, remova seu e-mail da lista e reinicie o backend. A conta continua podendo analisar documentos, passando a usar as cotas normais com os contadores já existentes.

## 5. Iniciar o servidor

```powershell
npm.cmd run dev
```

O terminal deve mostrar:

```text
API acadêmica disponível na porta 3000
```

A porta corresponde ao valor de `PORT` no `.env`. Mantenha esse terminal aberto: o comando acompanha alterações no código e reinicia o servidor automaticamente. Para encerrar, pressione **Ctrl+C**.

## 6. Verificar se a API está respondendo

Abra outro terminal e execute:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/health" | ConvertTo-Json -Depth 5
```

Ou abra [http://localhost:3000/health](http://localhost:3000/health) no navegador do computador.

O resultado deve conter `"status": "ok"`. O campo `ai.credentialsConfigured` indica se há uma chave preenchida para o provedor principal. Essa rota não valida a chave no provedor nem testa acesso ao Firebase; a extração de um documento pelo aplicativo é necessária para validar o fluxo completo.

Se você alterou `PORT`, ajuste também a porta no endereço de teste. No celular, `localhost` aponta para o próprio aparelho; configurar a conexão do app com uma API local exige um endereço acessível e uma configuração de rede compatível no mobile. Executar o backend local não altera automaticamente a URL usada pelo app.

## 7. Executar novamente nos próximos dias

Depois da instalação e da configuração inicial, basta executar:

```powershell
Set-Location "C:\Users\silva\Documents\agendaAcademica\Agenda-academica-backend"
npm.cmd run dev
```

## Problemas comuns

| Mensagem ou sintoma | Como resolver |
| --- | --- |
| `npm.cmd não é reconhecido` | Confira a instalação com os comandos do passo 1. Se já estiver instalado, atualize o PATH da sessão ou feche completamente e reabra o editor. |
| `npm ci` exige `package-lock.json` | Confira a pasta atual com `Get-Location`. Entre na pasta do backend, onde o arquivo já existe. Se ele estiver faltando no checkout, restaure a versão do repositório. |
| `npm.ps1 não pode ser carregado` | Use `npm.cmd`, conforme os exemplos, sem alterar a política de execução do Windows. |
| `tsx` não encontrado ou dependência ausente | Execute `npm.cmd ci` na pasta do backend e aguarde a conclusão sem erros. |
| `EADDRINUSE` | A porta já está ocupada. Encerre a outra execução do backend com Ctrl+C ou escolha outra `PORT` no `.env` e reinicie. |
| Erro de credencial padrão ou conta de serviço | Confira o caminho em `GOOGLE_APPLICATION_CREDENTIALS`, a existência do JSON e as permissões da conta. |
| Extração retorna HTTP 401 | Confira o login, o ID token Firebase enviado pelo app e o projeto Firebase. Não é necessário cadastrar o UID em uma lista de testadores. |
| Relatório retorna HTTP 403 | Confira se o UID da conta está em `ADMIN_UIDS`. A lista de isenção de cotas não concede acesso administrativo. |
| `/health` funciona, mas a extração falha | Confira a chave e o modelo de IA, as credenciais e o acesso ao Firestore, as cotas e o erro exibido no terminal. |

O `pip` instala pacotes Python; este backend usa Node.js e npm.

## Comandos de validação e execução compilada

Na pasta do backend:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd start
```

Execute cada etapa após a anterior terminar com sucesso. `npm.cmd start` executa o código compilado e precisa de um build prévio. Encerre o servidor de desenvolvimento antes de iniciar outra execução na mesma porta. As mesmas variáveis e credenciais do `.env` continuam necessárias.
