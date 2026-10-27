import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const prompt = createInterface({ input: stdin, output: stdout });
const url = (await prompt.question("Supabase project URL: ")).trim();
const publishableKey = (await prompt.question("Supabase publishable key: ")).trim();
prompt.close();

if (!url.startsWith("https://") || !publishableKey) {
  throw new Error("Enter a valid HTTPS project URL and publishable key.");
}

await writeFile(".env.local", `NEXT_PUBLIC_SUPABASE_URL=${url}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${publishableKey}\n`, { mode: 0o600 });
stdout.write("Saved Supabase settings to .env.local.\n");
