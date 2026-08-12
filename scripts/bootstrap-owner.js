/**
 * ONE-TIME migration for the multi-school upgrade.
 *
 * What it does:
 *  1. Creates a default school ("ADIS") if none exists yet, and backfills
 *     schoolId onto every existing users/classes/attendance/announcements/
 *     materials/auditLogs document that doesn't have one — this is how
 *     all your current data (which predates the multi-school model) gets
 *     attached to a real school instead of floating unscoped.
 *  2. Creates the first Owner account, if one doesn't already exist.
 *  3. Adds a couple of safety indexes (unique studentId, unique schoolId).
 *
 * Safe to re-run: every step checks "does this already exist?" first.
 *
 * Usage (from Termux, in the repo root):
 *   MONGO_URI="<your Mongo URI>" \
 *   OWNER_ID="owner1" \
 *   OWNER_PASSWORD="<a strong password>" \
 *   OWNER_NAME="Darshan" \
 *   node scripts/bootstrap-owner.js
 */

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const DEFAULT_SCHOOL_ID = 'ADIS';
const DEFAULT_SCHOOL_NAME = 'Ashwamedh Dream International School';

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('Set MONGO_URI before running this script.');

    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('ADIS_Portal');

    try {
        // --- 1. Default school + backfill ---
        let school = await db.collection('schools').findOne({ schoolId: DEFAULT_SCHOOL_ID });
        if (!school) {
            await db.collection('schools').insertOne({
                schoolId: DEFAULT_SCHOOL_ID,
                name: DEFAULT_SCHOOL_NAME,
                createdAt: new Date()
            });
            console.log(`✅ Created default school "${DEFAULT_SCHOOL_NAME}" (${DEFAULT_SCHOOL_ID})`);
        } else {
            console.log(`ℹ️  Default school already exists (${DEFAULT_SCHOOL_ID})`);
        }

        const backfillTargets = [
            { collection: 'users', filter: { schoolId: { $exists: false }, role: { $in: ['admin', 'teacher', 'student'] } } },
            { collection: 'classes', filter: { schoolId: { $exists: false } } },
            { collection: 'attendance', filter: { schoolId: { $exists: false } } },
            { collection: 'announcements', filter: { schoolId: { $exists: false } } },
            { collection: 'materials', filter: { schoolId: { $exists: false } } },
            { collection: 'auditLogs', filter: { schoolId: { $exists: false } } }
        ];
        for (const t of backfillTargets) {
            const result = await db.collection(t.collection).updateMany(t.filter, { $set: { schoolId: DEFAULT_SCHOOL_ID } });
            if (result.modifiedCount > 0) {
                console.log(`✅ Backfilled schoolId on ${result.modifiedCount} doc(s) in "${t.collection}"`);
            }
        }

        // --- 2. Owner account ---
        const existingOwner = await db.collection('users').findOne({ role: 'owner' });
        if (existingOwner) {
            console.log(`ℹ️  An owner account already exists (${existingOwner.studentId}) — skipping creation.`);
        } else {
            const ownerId = process.env.OWNER_ID;
            const ownerPassword = process.env.OWNER_PASSWORD;
            const ownerName = process.env.OWNER_NAME || 'Owner';
            if (!ownerId || !ownerPassword) {
                throw new Error('No owner exists yet — set OWNER_ID and OWNER_PASSWORD env vars to create one.');
            }
            const hashed = await bcrypt.hash(ownerPassword, 10);
            await db.collection('users').insertOne({
                studentId: ownerId,
                password: hashed,
                name: ownerName,
                role: 'owner',
                createdAt: new Date()
            });
            console.log(`✅ Created owner account "${ownerId}"`);
        }

        // --- 3. Safety indexes ---
        try {
            await db.collection('users').createIndex({ studentId: 1 }, { unique: true });
            await db.collection('schools').createIndex({ schoolId: 1 }, { unique: true });
            console.log('✅ Indexes ensured (unique studentId, unique schoolId)');
        } catch (e) {
            console.warn('⚠️  Index creation skipped/failed (likely already correct):', e.message);
        }

        console.log('\nDone. Log in with the owner id/password you just set to access the Owner Panel.');
    } finally {
        await client.close();
    }
}

main().catch(e => {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
});
