/**
 * 軌跡のマップ - ローカルAPIクライアント (サーバーレス版)
 * FastAPIの代わりに、ブラウザ内蔵のIndexedDB (Dexie.js) にデータを保存します。
 */

// 1. ローカルデータベースの定義（SQLiteのテーブル設計を再現）
const db = new Dexie("TrajectoryDB");
db.version(1).stores({
    pins: 'pin_id, title, latitude, longitude, status',
    payloads: 'pin_id', 
    hashChains: 'hash, pin_id, timestamp',
    topologyEdges: 'edge_id, node_a, node_b' 
});

// --- ユーティリティ関数 ---

// 簡易的なUUID生成
function generateUUID() {
    return crypto.randomUUID ? crypto.randomUUID() : 'xxxx-xxxx-xxxx'.replace(/[x]/g, () => (Math.random()*16|0).toString(16));
}

// 簡易的なハッシュ生成 (SHA-256)
async function generateHash(pinId, lat, lng, parentHash = null) {
    const data = JSON.stringify({ pin_id: pinId, lat, lng, parent_hash: parentHash });
    const msgBuffer = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ローカル用の簡易暗号化モック (UXを維持するためのパスワードロック機能)
function mockEncrypt(text, password) {
    const pwd = password || "";
    const msg = text || "";
    return btoa(encodeURIComponent(pwd + ":::" + msg));
}

function mockDecrypt(encryptedData, password) {
    const pwd = password || "";
    try {
        const decoded = decodeURIComponent(atob(encryptedData));
        const prefix = pwd + ":::";
        if (decoded.startsWith(prefix)) {
            return decoded.substring(prefix.length);
        } else {
            throw new Error("Password mismatch");
        }
    } catch (e) {
        throw new Error("パスワードが間違っているか、データが破損しています。");
    }
}

// --- APIの実装 (map.jsからの呼び出し口) ---
const API = {
    async createPin(pinData) {
        const pinId = generateUUID();
        const now = Date.now();
        let title = pinData.title;

        // 名前の自動生成
        if (!title) {
            const count = await db.pins.count();
            title = `名無しの場所${count + 1}`;
        }

        const encData = mockEncrypt(pinData.image_text, pinData.password);
        const genesisHash = await generateHash(pinId, pinData.latitude, pinData.longitude);

        // トランザクションで一括保存
        await db.transaction('rw', db.pins, db.payloads, db.hashChains, db.topologyEdges, async () => {
            await db.pins.add({
                pin_id: pinId, title: title,
                latitude: pinData.latitude, longitude: pinData.longitude,
                mode: pinData.mode || "A", owner_id: "local_user",
                created_at: now, status: "ACTIVE"
            });

            await db.payloads.add({ pin_id: pinId, encrypted_data: encData });
            await db.hashChains.add({ hash: genesisHash, pin_id: pinId, parent_hash: null, timestamp: now });

            if (pinData.warps && pinData.warps.length > 0) {
                for (const warp of pinData.warps) {
                    await db.topologyEdges.add({
                        edge_id: generateUUID(),
                        node_a: pinId, node_b: warp.target_pin_id,
                        cost_minutes: warp.cost_minutes, memo: warp.memo
                    });
                }
            }
        });

        return { status: "success", pin_id: pinId, hash: genesisHash };
    },

    async getNearbyPins(searchQuery = "") {
        let pins = await db.pins.where('status').equals('ACTIVE').toArray();
        if (searchQuery) {
            pins = pins.filter(p => p.title && p.title.includes(searchQuery));
        }
        return pins;
    },

    async getPinDetail(pinId) {
        const pin = await db.pins.get(pinId);
        if (!pin) throw new Error("ピンが見つかりません");

        const edges = await db.topologyEdges.where('node_a').equals(pinId).toArray();
        const warps = edges.map(e => ({
            target_pin_id: e.node_b,
            cost_minutes: e.cost_minutes,
            memo: e.memo
        }));

        return {
            pin_id: pin.pin_id, title: pin.title,
            latitude: pin.latitude, longitude: pin.longitude,
            warps: warps
        };
    },

    async updatePin(pinId, pinData) {
        await db.transaction('rw', db.pins, db.payloads, db.topologyEdges, async () => {
            if (pinData.title) await db.pins.update(pinId, { title: pinData.title });

            if (pinData.image_text !== null && pinData.password !== null) {
                const encData = mockEncrypt(pinData.image_text, pinData.password);
                await db.payloads.update(pinId, { encrypted_data: encData });
            }

            // ワープ情報の再構築
            const existingEdges = await db.topologyEdges.where('node_a').equals(pinId).primaryKeys();
            await db.topologyEdges.bulkDelete(existingEdges);

            if (pinData.warps && pinData.warps.length > 0) {
                for (const warp of pinData.warps) {
                    await db.topologyEdges.add({
                        edge_id: generateUUID(),
                        node_a: pinId, node_b: warp.target_pin_id,
                        cost_minutes: warp.cost_minutes, memo: warp.memo
                    });
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

        // 最新のハッシュ履歴を取得
        const chains = await db.hashChains.where('pin_id').equals(pinId).toArray();
        chains.sort((a, b) => b.timestamp - a.timestamp);
        const currentHash = chains.length > 0 ? chains[0].hash : null;

        const newHash = await generateHash(pinId, pin.latitude, pin.longitude, currentHash);
        const now = Date.now();

        await db.transaction('rw', db.pins, db.hashChains, async () => {
            await db.hashChains.add({ hash: newHash, pin_id: pinId, parent_hash: currentHash, timestamp: now });
            await db.pins.update(pinId, { owner_id: "local_user" });
        });

        return {
            status: "success", new_hash: newHash,
            decrypted_image_base64: decryptedText, message: "所有権の移転と復号に成功しました。"
        };
    }
};