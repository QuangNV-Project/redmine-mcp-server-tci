import type { Collection, Db } from "mongodb";
import { MongoClient } from "mongodb";
import type { ProjectConfig } from "./types.js";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(uri: string): Promise<void> {
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  console.error(`Connected to MongoDB`);
}

export async function disconnectMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

function getCollection(): Collection<ProjectConfig> {
  if (!db) throw new Error("MongoDB not connected. Set MONGODB_URI in .env");
  return db.collection<ProjectConfig>("projects");
}

export async function getProject(id: string): Promise<ProjectConfig | null> {
  return getCollection().findOne({ _id: id });
}

export async function getProjectByRedmineId(
  redmineProjectId: string
): Promise<ProjectConfig | null> {
  return getCollection().findOne({ redmine_project_id: redmineProjectId });
}

export async function findProjectByRedmine(
  projectName: string,
  projectId: number
): Promise<ProjectConfig | null> {
  return getCollection().findOne({
    $or: [
      { redmine_project_id: projectName },
      { redmine_project_id: String(projectId) },
      { name: projectName },
      {
        name: {
          $regex: new RegExp(`^${projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
        },
      },
    ],
  });
}

export async function listAllProjects(): Promise<ProjectConfig[]> {
  return getCollection().find().sort({ name: 1 }).toArray();
}

export async function upsertProject(
  project: Omit<ProjectConfig, "created_at" | "updated_at">
): Promise<ProjectConfig> {
  const now = new Date();
  const result = await getCollection().findOneAndUpdate(
    { _id: project._id },
    {
      $set: { ...project, updated_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  return result!;
}

export async function deleteProject(id: string): Promise<boolean> {
  const result = await getCollection().deleteOne({ _id: id });
  return result.deletedCount > 0;
}

process.on("SIGINT", () => void disconnectMongo());
process.on("SIGTERM", () => void disconnectMongo());
