# Estrutura do projeto (fullstack)

```
freeceptor/
├── app/                    # Next.js App Router
│   ├── api/                # Rotas de API (backend)
│   │   ├── hello/
│   │   │   └── route.ts
│   │   └── users/
│   │       └── route.ts
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
│
├── components/             # Componentes React
│   └── ui/                 # Componentes de UI reutilizáveis
│
├── hooks/                  # Custom hooks (useUsers, useAuth, etc.)
│
├── lib/                    # Código compartilhado
│   ├── api-client.ts       # Cliente para chamar /api/* no frontend
│   ├── db.ts               # Cliente de banco (Prisma, Drizzle, etc.)
│   ├── utils.ts            # Utilitários (cn, formatters, etc.)
│   └── server/             # Código que só roda no servidor
│       └── users.ts        # Serviços / lógica de negócio
│
├── types/                  # Tipos TypeScript compartilhados
│   └── index.ts
│
├── public/                 # Arquivos estáticos
└── docs/                   # Documentação
```

## Onde colocar cada coisa

| O quê | Onde |
|-------|------|
| Nova rota de API | `app/api/<recurso>/route.ts` |
| Lógica de negócio da API | `lib/server/<recurso>.ts` |
| Tipos usados no front e back | `types/index.ts` |
| Componentes de UI | `components/ui/` |
| Componentes por feature | `components/<feature>/` (ex: `components/auth/`) |
| Hooks que chamam API | `hooks/` (ex: `useUsers.ts`) |
| Chamadas ao backend no front | use `lib/api-client.ts` ou `fetch('/api/...')` |

## Alias `@/`

O projeto usa `@/*` para importar a partir da raiz:

- `@/components/ui`
- `@/lib/server/users`
- `@/types`
