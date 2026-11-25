import "dotenv/config";
import { applicationDefault, cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// Read-only: resolves existing users. Does not create accounts, send emails or grant claims.
async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("Configure FIREBASE_PROJECT_ID.");
  const adminEmails = (process.env.RELEASE_ADMIN_EMAILS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (!adminEmails.length) throw new Error("Configure RELEASE_ADMIN_EMAILS no .env local.");
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault();
  const app = initializeApp({ credential, projectId });
  try {
    const resolve = async (emails: string[]) => Promise.all(emails.map(async email => {
      const user = await getAuth(app).getUserByEmail(email);
      if (user.disabled) throw new Error("Uma das contas configuradas está desativada.");
      return user.uid;
    }));
    const admins = await resolve(adminEmails);
    console.log(`ADMIN_UIDS=${admins.join(",")}`);
  } finally { await deleteApp(app); }
}
main().catch(error => {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "CONFIGURATION_ERROR";
  console.error(`Não foi possível resolver as contas (${code}). Confira as credenciais, o projeto e se as contas já existem no Firebase Authentication.`);
  process.exitCode = 1;
});
