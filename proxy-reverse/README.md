# Freeceptor Reverse Proxy Agent

Agente de proxy reverso para o Freeceptor. Roda localmente (em Docker ou Node.js), mantém conexão persistente com o backend e expõe serviços locais para acesso remoto.

## Como Funciona

```
┌─────────────────┐                              ┌─────────────────┐
│   Cliente A     │◄────────────────────────────▶│   Cliente B     │
│  (Este Agent)   │       Via Freeceptor         │  (Outro Agent)  │
│                 │                              │                 │
│  Serviços:      │                              │  Serviços:      │
│  - api:3000     │                              │  - db:5432      │
│  - web:8080     │                              │  - cache:6379   │
└────────┬────────┘                              └────────┬────────┘
         │ WebSocket                                      │ WebSocket
         │ (conexão persistente)                          │ (conexão persistente)
         ▼                                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Freeceptor Backend                            │
│                                                                    │
│   - Lista de clientes conectados                                   │
│   - Roteia requisições entre clientes                              │
│   - Permite acessar serviços em máquinas remotas                   │
└───────────────────────────────────────────────────────────────────┘
                              ▲
                              │
                    ┌─────────────────┐
                    │    Frontend     │
                    │                 │
                    │  - Ver clientes │
                    │  - Enviar req.  │
                    │  - Ver respostas│
                    └─────────────────┘
```

## Funcionalidades

- **Conexão WebSocket persistente** com o backend Freeceptor
- **Auto-reconexão** em caso de desconexão
- **Exposição de serviços locais** para acesso remoto
- **Heartbeat automático** para manter conexão ativa
- **Execução de requisições** enviadas pelo backend

## Configuração

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `CLIENT_ID` | Não | ID único do cliente (auto-gerado se vazio) |
| `CLIENT_NAME` | Não | Nome legível do cliente (ex: "Servidor Produção") |
| `FREECEPTOR_URL` | Sim | URL do servidor Freeceptor |
| `SERVER_NAME` | Sim | Nome do server/namespace no Freeceptor |
| `SERVER_PASSWORD` | Não | Senha do server (se configurada) |
| `LOCAL_SERVICES` | Não | Serviços locais para expor (ver formato abaixo) |
| `VERBOSE` | Não | Habilita logs detalhados (padrão: `false`) |
| `RECONNECT_INTERVAL` | Não | Intervalo de reconexão em ms (padrão: `5000`) |

### Formato de LOCAL_SERVICES

```bash
# Formato: name:port ou name:host:port
# Múltiplos serviços separados por vírgula

# Exemplos:
LOCAL_SERVICES=api:3000
LOCAL_SERVICES=api:3000,postgres:5432
LOCAL_SERVICES=api:localhost:3000,db:192.168.1.100:5432
```

## Uso com Docker

### Build e Run

```bash
# Copie o arquivo de exemplo e configure
cp .env.example .env

# Edite o .env com suas configurações
nano .env

# Build da imagem
docker build -t freeceptor-agent .

# Run
docker run --env-file .env --network host freeceptor-agent
```

### Com Docker Compose

```bash
# Configure o .env
cp .env.example .env
nano .env

# Suba o serviço
docker compose up -d

# Veja os logs
docker compose logs -f
```

## Uso Local (Desenvolvimento)

```bash
# Instale as dependências
npm install

# Configure as variáveis de ambiente
export FREECEPTOR_URL=https://freeceptor.example.com
export SERVER_NAME=my-project
export CLIENT_NAME=my-dev-machine
export LOCAL_SERVICES=api:3000,db:5432

# Rode em modo desenvolvimento
npm run dev
```

## Exemplo Prático

### Cenário: Acessar banco de dados de produção remotamente

1. No servidor de produção, configure o agent:
   ```bash
   export FREECEPTOR_URL=https://meu-freeceptor.com
   export SERVER_NAME=producao
   export CLIENT_NAME=servidor-prod-db
   export LOCAL_SERVICES=postgres:5432,redis:6379
   ```

2. Suba o agent:
   ```bash
   docker compose up -d
   ```

3. No frontend do Freeceptor:
   - Veja o cliente "servidor-prod-db" na lista
   - Envie requisições para `postgres:5432` ou `redis:6379`
   - As requisições são executadas localmente no servidor de produção

## Logs

```
╔═══════════════════════════════════════════════════════════════════╗
║       Freeceptor Reverse Proxy Agent v2.0                         ║
╚═══════════════════════════════════════════════════════════════════╝

Configuration:
  Client ID:      client-abc123
  Client Name:    servidor-prod-db
  Freeceptor URL: https://meu-freeceptor.com
  Server Name:    producao
  Verbose:        false

Exposed Local Services:
  - postgres: localhost:5432
  - redis: localhost:6379

Connecting to Freeceptor...
[WebSocket] Connected to Freeceptor
[WebSocket] Registration successful
[Request] GET postgres/health (id: req-123)
[Response] req-123 -> 200
```

## Segurança

- O agent só executa requisições para serviços explicitamente configurados em `LOCAL_SERVICES`
- Use `SERVER_PASSWORD` para proteger o acesso ao seu namespace
- O agent não expõe portas localmente - toda comunicação passa pelo Freeceptor
- Considere usar HTTPS entre o agent e o Freeceptor
