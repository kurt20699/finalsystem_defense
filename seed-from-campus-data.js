    /**
     * seed-from-campus-data.js
     * One-time (or repeatable) seed: wipes buildings/rooms and repopulates them
     * from campus-data.js — the actual source of truth — instead of the stale
     * hardcoded arrays that used to live in server.js.
     *
     * Usage: node seed-from-campus-data.js
     */
    require("dotenv").config();
    const { Pool } = require("pg");
    const campusData = require("./campus-data.js");

    const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
    });

    async function seed() {
    let buildingCount = 0;
    let roomCount = 0;
    let skippedBuildings = 0;
    let skippedRooms = 0;
    let renamedRooms = 0;

    // ✅ Don't wipe existing buildings — that also destroys any admin-drawn
    // footprint/color data, since campus-data.js never had footprints to
    // begin with. Only insert buildings that aren't already in the DB.
    const existingRes = await pool.query("SELECT short_name FROM buildings");
    const existingShortNames = new Set(existingRes.rows.map(r => r.short_name));

    for (const campusKey of Object.keys(campusData)) {
        const campus = campusData[campusKey];
        if (!campus.locations) continue;

        for (const loc of campus.locations) {
        if (existingShortNames.has(loc.shortName)) {
            // Already in DB: keep its footprint/color, but fill in a missing
            // description/photo from campus-data.js (never overwrites one you set).
            await pool.query(
            `UPDATE buildings
                SET description = COALESCE(NULLIF(description, ''), $2),
                    photo       = COALESCE(NULLIF(photo, ''), $3)
                WHERE short_name = $1`,
            [loc.shortName, loc.description || null, loc.photo || loc.image || null]
            );

            // ✅ Rename rooms you changed in campus-data.js. A room is matched by its
            // map coordinates: if the old name is gone from campus-data.js but a room in
            // this building sits at the same spot as a room that has a new name, it is
            // renamed in place (same id, floor, instructor, etc. are kept).
            // Rooms are never added or deleted here, so rooms you added or removed in
            // the Admin Dashboard stay as they are.
            if (Array.isArray(loc.rooms)) {
            const nameOf = (room) => (typeof room === "string" ? room : room.name);
            const namesInFile = new Set(loc.rooms.map(nameOf));
            const dbRooms = (await pool.query(
                "SELECT id, name, lat, lng FROM rooms WHERE building = $1", [loc.shortName]
            )).rows;
            const dbNames = new Set(dbRooms.map(r => r.name));
            const claimed = new Set();
            for (const room of loc.rooms) {
                if (typeof room === "string" || !room.coords) continue;   // no coordinates → can't tell it's a rename
                if (dbNames.has(room.name)) continue;                     // name already in the DB
                const [rLat, rLng] = room.coords;
                const old = dbRooms.find(r =>
                !claimed.has(r.id) && !namesInFile.has(r.name) &&         // old name no longer in campus-data.js
                r.lat != null && r.lng != null &&
                Math.abs(Number(r.lat) - rLat) < 1e-5 && Math.abs(Number(r.lng) - rLng) < 1e-5
                );
                if (!old) continue;
                try {
                await pool.query("UPDATE rooms SET name = $1 WHERE id = $2", [room.name, old.id]);
                claimed.add(old.id);
                renamedRooms++;
                console.log(`✏️  ${loc.shortName}: renamed room "${old.name}" → "${room.name}"`);
                } catch (err) {
                console.warn(`⚠️  Could not rename "${old.name}" in "${loc.shortName}": ${err.message}`);
                }
            }
            }
            continue;
        }
        const [lat, lng] = loc.coords || [null, null];

        // ── Insert building — isolated so one bad row doesn't kill the whole seed ──
        try {
            await pool.query(
            `INSERT INTO buildings (name, short_name, type, lat, lng, description, photo)
                VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [loc.name, loc.shortName, loc.type, lat, lng, loc.description || null, loc.photo || loc.image || null]
            );
            buildingCount++;
        } catch (err) {
            console.warn(`⚠️  Skipped building "${loc.name}" (${loc.shortName}): ${err.message}`);
            skippedBuildings++;
            continue; // don't attempt rooms for a building that failed to insert
        }

        if (Array.isArray(loc.rooms)) {
            for (const room of loc.rooms) {
            try {
                if (typeof room === "string") {
                // Some entries (Registrar, Library, GAD, Cafeteria, Clinic, Dormitory,
                // Cooperative Canteen) list rooms as plain name strings with no coords.
                // floor is NOT NULL in the schema, so default to '—' — same convention
                // your existing /api/admin/rooms route already uses.
                await pool.query(
                    `INSERT INTO rooms (building, name, floor, lat, lng) VALUES ($1,$2,$3,$4,$5)`,
                    [loc.shortName, room, "—", null, null]
                );
                } else {
                const [rLat, rLng] = room.coords || [null, null];
                const [offX, offY] = room.iconOffset || [0, 0];
                await pool.query(
                    `INSERT INTO rooms (building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [loc.shortName, room.name, room.floor || "—", room.instructor || null, rLat, rLng, offX, offY]
                );
                }
                roomCount++;
            } catch (err) {
                const roomName = typeof room === "string" ? room : room.name;
                console.warn(`⚠️  Skipped room "${roomName}" in "${loc.shortName}": ${err.message}`);
                skippedRooms++;
            }
            }
        }
        }
    }

    console.log(`\nSeeded ${buildingCount} buildings, ${roomCount} rooms.`);
    if (renamedRooms) console.log(`Renamed ${renamedRooms} room(s) to match campus-data.js.`);
    if (skippedBuildings || skippedRooms) {
        console.log(`Skipped ${skippedBuildings} buildings, ${skippedRooms} rooms — see warnings above.`);
    }
    await pool.end();
    }

    seed().catch(err => {
    console.error("Seed failed:", err);
    process.exit(1);
    });