# Freeceptor Reverse Proxy Agent

Agente de proxy reverso para o Freeceptor. Conecta-se ao backend via **WebSocket** para comunicação bidirecional em tempo real.

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
│   - Mantém conexões WebSocket com todos os clientes                │
│   - Roteia requisições entre clientes em tempo real                │
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
- **Comunicação bidirecional** em tempo real
- **Auto-reconexão** com backoff exponencial
- **Heartbeat automático** a cada 30s para manter conexão ativa
- **Execução de requisições** em serviços locais

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
| `RECONNECT_INTERVAL` | Não | Intervalo base de reconexão em ms (padrão: `5000`) |

### Formato de LOCAL_SERVICES

```bash
# Formato: name:port ou name:host:port
# Múltiplos serviços separados por vírgula

# Exemplos:
LOCAL_SERVICES=api:3000
LOCAL_SERVICES=api:3000,postgres:5432
LOCAL_SERVICES=api:localhost:3000,db:192.168.1.100:5432
```

## Protocolo WebSocket

### Mensagens do Cliente → Servidor

| Tipo | Descrição |
|------|-----------|
| `register` | Registra o cliente com seus serviços locais |
| `heartbeat` | Mantém a conexão ativa |
| `response` | Resposta de uma requisição executada |

### Mensagens do Servidor → Cliente

| Tipo | Descrição |
|------|-----------|
| `welcome` | Confirmação de conexão |
| `register_ack` | Confirmação de registro |
| `heartbeat_ack` | Confirmação de heartbeat |
| `request` | Requisição para executar em serviço local |
| `error` | Mensagem de erro |

## Uso com Docker

### Build e Run

```bash
# Copie o arquivo de exemplo e configure
cp .env.example .env

# Edite o .env com suas configurações
nano .env

# Build da imagem
docker build -t freeceptor-agent .

# Run (--network host para acessar serviços locais)
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
# Docker Mac = export FREECEPTOR_URL=http://host.docker.internal:3002
# Docker Linux = export FREECEPTOR_URL=http://172.17.0.1:3002
export FREECEPTOR_URL=http://host.docker.internal:3002
export SERVER_NAME=dev
export CLIENT_NAME=my-dev-machine
export LOCAL_SERVICES=api:3000,db:5432

# Rode em modo desenvolvimento
npm run dev
```

## Logs

```
╔═══════════════════════════════════════════════════════════════════╗
║       Freeceptor Reverse Proxy Agent v2.0                         ║
║                  (WebSocket Mode)                                 ║
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

Connecting to Freeceptor via WebSocket...
[WebSocket] Connected to Freeceptor
[WebSocket] Registration successful
[Request] GET postgres/health (id: req-123)
[Response] req-123 -> 200
```

## Segurança

- O agent só executa requisições para serviços explicitamente configurados em `LOCAL_SERVICES`
- Use `SERVER_PASSWORD` para proteger o acesso ao seu namespace
- O agent não expõe portas localmente - toda comunicação passa pelo Freeceptor
- Use HTTPS/WSS em produção para comunicação segura
- Auto-reconexão com backoff exponencial previne sobrecarga do servidor
