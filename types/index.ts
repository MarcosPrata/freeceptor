/**
 * Tipos compartilhados entre frontend e backend.
 */

export type User = {
  id: string;
  name: string;
  email: string;
};

export type CreateUserInput = {
  name: string;
  email: string;
};
