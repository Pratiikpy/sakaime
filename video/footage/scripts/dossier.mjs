// Scene "Signed dossier": export, verify, change one character, and watch the verifier name the failing item.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto(`/cases/${CASE}/dossier`, { settle: 1200 });
  await s.mark("start", null, { hold: 700 });
  await s.click(page.getByRole("button", { name: /Export the dossier|Export again/ }), { after: 900 });
  await page.getByTestId("dossier-summary").waitFor({ timeout: 20000 }).catch(() => {});
  await s.mark("exported", page.getByTestId("dossier-summary"), { hold: 1500 });
  await s.click(page.getByRole("button", { name: "Run the verifier" }), { after: 900 });
  await page.getByTestId("verify-result").waitFor({ timeout: 20000 });
  await s.scrollTo(page.getByTestId("verify-result"), { offset: 250, ms: 900 });
  await s.mark("verified", page.getByTestId("verify-result"), { hold: 1900 });
  await s.click(page.getByRole("button", { name: "Change one character and verify the copy" }), { after: 900 });
  await page.getByTestId("tamper-out").waitFor({ timeout: 20000 });
  await s.scrollTo(page.getByTestId("tamper-out"), { offset: 250, ms: 900 });
  await s.mark("tampered", page.getByTestId("tamper-out"), { hold: 2600 });
  const note = page.getByTestId("signature-note");
  if (await note.count()) {
    await s.scrollTo(note, { offset: 350, ms: 900 });
    await s.mark("signature", note, { hold: 1800 });
  }
}
