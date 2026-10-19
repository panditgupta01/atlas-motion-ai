import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalStorage, assertValidKey, newObjectKey } from "@atlas/server-core";

const U = "a".repeat(24);
const P = "b".repeat(24);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-storage-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("storage keys", () => {
  it("generates keys scoped to the user and project", () => {
    const key = newObjectKey({ userId: U, projectId: P, folder: "renders", ext: "mp4" });
    expect(key).toMatch(new RegExp(`^users/${U}/projects/${P}/renders/[a-f0-9]+\\.mp4$`));
    expect(assertValidKey(key)).toBe(key);
  });

  it("rejects traversal and absolute keys", () => {
    for (const bad of ["../x.mp4", "/etc/passwd", `users/${U}/../../x`, `users/${U}/a b.mp4`, "users/u1/x.mp4", ""]) expect(() => assertValidKey(bad)).toThrow();
  });
});

describe("local storage driver", () => {
  it("stores, reads back and deletes a file", async () => {
    const storage = new LocalStorage(root);
    const src = path.join(root, "src.bin");
    fs.writeFileSync(src, Buffer.from("hello"));
    const key = newObjectKey({ userId: U, projectId: P, folder: "renders", ext: "mp4" });
    const info = await storage.putFile(key, src, "video/mp4");
    expect(info.sizeBytes).toBe(5);
    const target = await storage.download(key, "out.mp4", "video/mp4");
    expect(target.filePath && fs.readFileSync(target.filePath, "utf8")).toBe("hello");
    await storage.delete(key);
    expect(fs.existsSync(target.filePath!)).toBe(false);
  });
});
