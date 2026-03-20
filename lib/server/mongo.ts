import { MongoClient, type Db } from "mongodb";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/freeceptor";
const dbName = process.env.MONGODB_DB ?? "freeceptor";

declare global {
  var __freeceptorMongoClientPromise: Promise<MongoClient> | undefined;
}

function createClientPromise() {
  const client = new MongoClient(uri);
  return client.connect();
}

const clientPromise =
  global.__freeceptorMongoClientPromise ?? createClientPromise();

if (process.env.NODE_ENV !== "production") {
  global.__freeceptorMongoClientPromise = clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await clientPromise;
  return client.db(dbName);
}
