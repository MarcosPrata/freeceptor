/**
 * Serviço de usuários (lógica de negócio do backend).
 * Usado pelas rotas em app/api/users.
 */

import type { User, CreateUserInput } from "@/types";

const users: User[] = [
  { id: "1", name: "Maria", email: "maria@exemplo.com" },
  { id: "2", name: "João", email: "joao@exemplo.com" },
];

export function getUsers(): User[] {
  return users;
}

export function createUser(input: CreateUserInput): User {
  const newUser: User = {
    id: String(users.length + 1),
    name: input.name,
    email: input.email,
  };
  users.push(newUser);
  return newUser;
}
