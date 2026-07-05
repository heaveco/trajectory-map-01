/**
 * 軌跡のマップ - ローカルAPIクライアント (サーバーレス版)
 */

const db = new Dexie("TrajectoryDB");
db.version(1).stores({
    pins: 'pin_id, title, latitude, longitude, status',
    payloads: 'pin_id', 
    hashChains: 'hash, pin_id, timestamp',
    topologyEdges: 'edge_id, node_a, node_b' 
});

function generateUUID() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxx-xxxx-xxxx'.replace(/[x]/g, () => (Math.random()*16|0).toString(16)); }

async function generateHash(pinId, lat, lng, parentHash = null) {
    const data = JSON.stringify({ pin_id: pinId, lat, lng, parent_hash: parentHash });
    const msgBuffer = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function mockEncrypt(text, password) {
    return btoa(encodeURIComponent((password || "") + ":::" + (text || "")));
}

function mockDecrypt(encryptedData, password) {
    try {
        const decoded = decodeURIComponent(atob(encryptedData));
        const prefix = (password || "") + ":::";
        if (decoded.startsWith(prefix)) return decoded.substring(prefix.length);
        throw new Error("Password mismatch");
    } catch (e) {
        throw new Error("パスワードが間違っているか、データが破損しています。");
    }
}

const API = {
    async createPin(pinData) {
        const pinId = generateUUID();
        const now = Date.now();
        let title = pinData.title;

        if (!title) {
            const count = await db.pins.count();
            title = `名無しの場所${count + 1}`;
        }

        const encData = mockEncrypt(pinData.image_text, pinData.password);
        const genesisHash = await generateHash(pinId, pinData.latitude, pinData.longitude);

        await db.transaction('rw', db.pins, db.payloads, db.hashChains, db.topologyEdges, async () => {
            await db.pins.add({
                pin_id: pinId, title: title,
                latitude: pinData.latitude, longitude: pinData.longitude,
                mode: pinData.mode || "A", owner_id: "local_user",
                created_at: now, status: "ACTIVE",
                is_public: pinData.is_public || false // [NEW] 放流フラグの保存
            });

            await db.payloads.add({ pin_id: pinId, encrypted_data: encData });
            await db.hashChains.add({ hash: genesisHash, pin_id: pinId, parent_hash: null, timestamp: now });

            if (pinData.warps && pinData.warps.length > 0) {
                for (const warp of pinData.warps) {
                    await db.topologyEdges.add({ edge_id: generateUUID(), node_a: pinId, node_b: warp.target_pin_id, cost_minutes: warp.cost_minutes, memo: warp.memo });
                }
            }
        });
        return { status: "success", pin_id: pinId, hash: genesisHash };
    },

    // [NEW] appMode を受け取り、EXPLORE/GUIDE モードの時は放流済みのみを返す
    async getNearbyPins(searchQuery = "", appMode = "EXPLORE") {
        let pins = await db.pins.where('status').equals('ACTIVE').toArray();
        
        // 探索・案内モードでは「放流済み (is_public == true)」のピンだけを抽出
        if (appMode === 'EXPLORE' || appMode === 'GUIDE') {
            pins = pins.filter(p => p.is_public === true);
        }

        if (searchQuery) {
            pins = pins.filter(p => p.title && p.title.includes(searchQuery));
        }
        return pins;
    },

    async getPinDetail(pinId) {
        const pin = await db.pins.get(pinId);
        if (!pin) throw new Error("ピンが見つかりません");

        const edges = await db.topologyEdges.where('node_a').equals(pinId).toArray();
        return {
            pin_id: pin.pin_id, title: pin.title,
            latitude: pin.latitude, longitude: pin.longitude,
            is_public: pin.is_public || false, // [NEW] 放流フラグを取得
            warps: edges.map(e => ({ target_pin_id: e.node_b, cost_minutes: e.cost_minutes, memo: e.memo }))
        };
    },

    async updatePin(pinId, pinData) {
        await db.transaction('rw', db.pins, db.payloads, db.topologyEdges, async () => {
            const updates = {};
            if (pinData.title !== undefined) updates.title = pinData.title;
            if (pinData.is_public !== undefined) updates.is_public = pinData.is_public; // [NEW] 放流フラグの更新

            if (Object.keys(updates).length > 0) await db.pins.update(pinId, updates);

            if (pinData.image_text !== null && pinData.password !== null) {
                const encData = mockEncrypt(pinData.image_text, pinData.password);
                await db.payloads.update(pinId, { encrypted_data: encData });
            }

            const existingEdges = await db.topologyEdges.where('node_a').equals(pinId).primaryKeys();
            await db.topologyEdges.bulkDelete(existingEdges);

            if (pinData.warps && pinData.warps.length > 0) {
                for (const warp of pinData.warps) {
                    await db.topologyEdges.add({ edge_id: generateUUID(), node_a: pinId, node_b: warp.target_pin_id, cost_minutes: warp.cost_minutes, memo: warp.memo });
                }
            }
        });
        return { status: "success", pin_id: pinId };
    },

    async pickPin(pinId, requestData) {
        const pin = await db.pins.get(pinId);
        const payload = await db.payloads.get(pinId);
        if (!pin || !payload) throw new Error("ピンが見つかりません。");

        const decryptedText = mockDecrypt(payload.encrypted_data, requestData.password);
        const chains = await db.hashChains.where('pin_id').equals(pinId).toArray();
        chains.sort((a, b) => b.timestamp - a.timestamp);
        const currentHash = chains.length > 0 ? chains[0].hash : null;

        const newHash = await generateHash(pinId, pin.latitude, pin.longitude, currentHash);
        const now = Date.now();

        await db.transaction('rw', db.pins, db.hashChains, async () => {
            await db.hashChains.add({ hash: newHash, pin_id: pinId, parent_hash: currentHash, timestamp: now });
            await db.pins.update(pinId, { owner_id: "local_user" });
        });

        return { status: "success", new_hash: newHash, decrypted_image_base64: decryptedText, message: "所有権の移転と復号に成功しました。" };
    }
};