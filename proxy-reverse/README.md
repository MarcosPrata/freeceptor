# Freeceptor Reverse Proxy Agent

Agente de proxy reverso para o Freeceptor. Roda localmente (em Docker ou Node.js) para interceptar requisições e registrá-las no servidor Freeceptor.

## Como Funciona

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Sua App       │────▶│   Proxy Reverso     │────▶│   API Real      │
│   (Cliente)     │     │   (Este Container)  │     │   (TARGET_URL)  │
└─────────────────┘     └──────────┬──────────┘     └─────────────────┘
                                   │
                                   │ Logs
                                   ▼
                        ┌─────────────────────┐
                        │   Freeceptor        │
                        │   (Backend)         │
                        └─────────────────────┘
```

1. Sua aplicação faz requisições para o proxy local (ex: `http://localhost:8080`)
2. O proxy encaminha a requisição para a API real (`TARGET_URL`)
3. A resposta é retornada para sua aplicação
4. Em paralelo, a requisição e resposta são registradas no Freeceptor

## Configuração

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `LOCAL_PORT` | Não | Porta local do proxy (padrão: `8080`) |
| `FREECEPTOR_URL` | Sim | URL do servidor Freeceptor |
| `SERVER_NAME` | Sim | Nome do server no Freeceptor |
| `SERVER_PASSWORD` | Não | Senha do server (se configurada) |
| `TARGET_URL` | Sim | URL da API real para onde as requisições serão encaminhadas |
| `VERBOSE` | Não | Habilita logs detalhados (padrão: `false`) |

## Uso com Docker

### Build e Run

```bash
# Copie o arquivo de exemplo e configure
cp .env.example .env

# Edite o .env com suas configurações
nano .env

# Build da imagem
docker build -t freeceptor-proxy .

# Run
docker run --env-file .env -p 8080:8080 freeceptor-proxy
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
export TARGET_URL=https://api.example.com

# Rode em modo desenvolvimento
npm run dev
```

## Exemplo Prático

Suponha que você tem uma aplicação que chama `https://api.stripe.com`:

1. Configure o proxy:
   ```bash
   export FREECEPTOR_URL=https://meu-freeceptor.com
   export SERVER_NAME=stripe-integration
   export TARGET_URL=https://api.stripe.com
   export LOCAL_PORT=8080
   ```

2. Suba o proxy:
   ```bash
   docker compose up -d
   ```

3. Configure sua aplicação para usar `http://localhost:8080` ao invés de `https://api.stripe.com`

4. Todas as requisições serão:
   - Encaminhadas para a API real do Stripe
   - Registradas no Freeceptor para análise

## Logs

Com `VERBOSE=true`, o proxy exibe logs detalhados:

```
[Proxy] POST /v1/customers
[Proxy] POST /v1/customers -> 200 (145ms)
[Proxy] GET /v1/charges/ch_xxx
[Proxy] GET /v1/charges/ch_xxx -> 200 (89ms)
```

## Segurança

- O proxy **não modifica** o conteúdo das requisições
- Os dados são enviados ao Freeceptor em paralelo, sem bloquear a resposta
- Use `SERVER_PASSWORD` para proteger seus logs no Freeceptor
- Em produção, considere usar HTTPS entre o proxy e o Freeceptor
