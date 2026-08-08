/**
 * Ardosis client — Node/CommonJS port of src/sdk/ardosis-sdk.ts, for use
 * from server.js (this app is Express, not Next.js, so it can't import
 * the .ts SDK file directly).
 *
 * Reads config from environment variables only — no key is hardcoded
 * here. Set these on Render (Settings -> Environment):
 *   ARDOSIS_BASE_URL = https://ardosis.vercel.app   (optional, this is the default)
 *   ARDOSIS_API_KEY  = <the key generated for "ADIS Portal" in Ardosis -> Apps>
 *
 * ADIS Portal has no email field anywhere (students/teachers log in with
 * a studentId + password only) but Ardosis requires a unique, valid-format
 * email per user. We synthesize one as `${studentId}@adis-portal.local` —
 * stable, unique per user, and namespaced so it can never collide with a
 * real email from another connected app. It's not a real inbox; nothing
 * in Ardosis emails these addresses today (Resend integration isn't wired
 * up yet), but keep that in mind if that changes later.
 *
 * Every method here fails silently (returns null) instead of throwing —
 * a down/misconfigured Ardosis should never break an actual school login
 * or record save.
 */

const BASE_URL = (process.env.ARDOSIS_BASE_URL || "https://ardosis.vercel.app").replace(/\/$/, "");
const API_KEY = process.env.ARDOSIS_API_KEY || "";

function studentIdToEmail(studentId) {
    return `${studentId}@adis-portal.local`;
}

async function request(path, init) {
    if (!API_KEY) {
        // Not configured yet — no-op rather than spamming errors.
        return null;
    }
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`,
                ...(init && init.headers)
            }
        });
        if (!res.ok) {
            console.error(`Ardosis sync failed (${res.status}) for ${path}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        console.error("Ardosis sync error:", e.message);
        return null;
    }
}

/**
 * Call this after any successful login, or after an admin/teacher creates
 * or updates a student/teacher record, so that person shows up (or stays
 * up to date) in the Ardosis dashboard.
 *
 * @param {{ studentId: string, name?: string }} input
 */
async function syncUser({ studentId, name }) {
    const body = { email: studentIdToEmail(studentId) };
    if (name) body.name = name;
    const data = await request("/api/sdk/v1/user", {
        method: "POST",
        body: JSON.stringify(body)
    });
    return data ? data.user : null;
}

module.exports = { syncUser, studentIdToEmail };
