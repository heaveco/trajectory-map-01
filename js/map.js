let trajectoryMap;
let markers = [];
window.cachedPins = [];
let appMode = 'EXPLORE';

// 関数をまたいで使う変数群
let modal;
let warpContainer;
let pendingLocation = null;
let editingPinId = null;

// [NEW] リアルタイムGPSトラッキング用変数
let watchId = null;
let userMarker = null;

function initMap() {
    trajectoryMap = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {},
            layers: [{
                id: 'background',
                type: 'background',
                paint: { 'background-color': '#111111' }
            }]
        },
        center: [139.6917, 35.6895],
        zoom: 12
    });

    const btnExplore = document.getElementById('btn-mode-explore');
    const btnCreate = document.getElementById('btn-mode-create');
    const btnGuide = document.getElementById('btn-mode-guide'); // [NEW]
    const btnCurrentLoc = document.getElementById('btn-current-loc');

    // [NEW] モード切替を管理する関数
    function switchMode(newMode) {
        appMode = newMode;

        // ボタンの見た目をリセット
        [btnExplore, btnCreate, btnGuide].forEach(btn => {
            btn.style.background = '#222';
            btn.style.color = '#aaa';
            btn.style.fontWeight = 'normal';
        });

        // 選択されたボタンをハイライト
        const activeBtn = appMode === 'EXPLORE' ? btnExplore : (appMode === 'CREATE' ? btnCreate : btnGuide);
        activeBtn.style.background = '#fff';
        activeBtn.style.color = '#000';
        activeBtn.style.fontWeight = 'bold';

        // UIとカーソルの変更
        trajectoryMap.getCanvas().style.cursor = appMode === 'CREATE' ? 'crosshair' : '';
        btnCurrentLoc.style.display = appMode === 'CREATE' ? 'block' : 'none';

        // 案内モードの処理: リアルタイムGPS追跡を開始
        if (appMode === 'GUIDE') {
            if (!navigator.geolocation) {
                alert("この端末はGPSに対応していません。");
                return;
            }
            if (!watchId) {
                watchId = navigator.geolocation.watchPosition(
                    (position) => {
                        const lat = position.coords.latitude;
                        const lng = position.coords.longitude;
                        
                        // compass.js 向けにグローバルの現在地を更新
                        if (window.updateLocation) {
                            window.updateLocation(lng, lat);
                        }

                        // マップ上に現在地(青い点)を描画・更新
                        if (!userMarker) {
                            const el = document.createElement('div');
                            el.style.width = '16px'; el.style.height = '16px';
                            el.style.background = '#007aff'; 
                            el.style.borderRadius = '50%';
                            el.style.border = '2px solid #fff'; 
                            el.style.boxShadow = '0 0 10px rgba(0,122,255,0.8)';
                            
                            userMarker = new maplibregl.Marker({ element: el })
                                .setLngLat([lng, lat])
                                .addTo(trajectoryMap);
                            
                            trajectoryMap.flyTo({ center: [lng, lat], zoom: 16 });
                        } else {
                            userMarker.setLngLat([lng, lat]);
                        }
                    },
                    (error) => { console.warn("GPSの追跡に失敗しました", error); },
                    { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
                );
            }
        } else {
            // 案内モード以外ならトラッキングを停止してリソースを節約
            if (watchId) {
                navigator.geolocation.clearWatch(watchId);
                watchId = null;
            }
            if (userMarker) {
                userMarker.remove();
                userMarker = null;
            }
        }
    }

    // ボタンクリックイベントの設定
    btnExplore.addEventListener('click', () => switchMode('EXPLORE'));
    btnCreate.addEventListener('click', () => switchMode('CREATE'));
    
    // [NEW] 案内モード起動時のコンパス許可（iPhone Safari専用対応）
    btnGuide.addEventListener('click', async () => {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission !== 'granted') {
                    alert("コンパスへのアクセスが拒否されました。方角は動作しません。");
                }
            } catch (err) {
                console.error("コンパス権限エラー:", err);
            }
        }
        switchMode('GUIDE');
    });

    // アプリ起動時の初期モード
    switchMode('EXPLORE');

    // DOM要素の取得
    modal = document.getElementById('pin-modal');
    warpContainer = document.getElementById('warp-list-container');

    // 「＋追加」ボタンと検索ボタンのイベント
    document.getElementById('add-warp-btn').addEventListener('click', () => addWarpRow());
    document.getElementById('search-btn').addEventListener('click', () => {
        const query = document.getElementById('search-input').value;
        loadPins(query);
    });

    // 現在地ボタンの処理 (記録モードでの単発取得)
    btnCurrentLoc.addEventListener('click', () => {
        if (!navigator.geolocation) {
            alert("この端末はGPSに対応していません。");
            return;
        }

        const originalText = btnCurrentLoc.innerText;
        btnCurrentLoc.innerText = "取得中...";

        navigator.geolocation.getCurrentPosition(
            (position) => {
                btnCurrentLoc.innerText = originalText;
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                
                trajectoryMap.flyTo({ center: [lng, lat], zoom: 15 });

                editingPinId = null; 
                pendingLocation = { lat: lat, lng: lng };
                
                document.getElementById('modal-title').value = "";
                document.getElementById('modal-lat').value = lat.toFixed(6); 
                document.getElementById('modal-lng').value = lng.toFixed(6); 
                document.getElementById('modal-message').value = "";
                document.getElementById('modal-password').value = "";
                warpContainer.innerHTML = "";
                
                modal.style.display = 'flex';
            },
            (error) => {
                btnCurrentLoc.innerText = originalText;
                alert("GPSの取得に失敗しました: " + error.message);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    });

    // 地図クリック時 (手動でピンを打つ)
    trajectoryMap.on('click', (e) => {
        if (appMode !== 'CREATE') return; // CREATEモード以外では何もしない

        editingPinId = null; 
        pendingLocation = e.lngLat;

        document.getElementById('modal-title').value = "";
        document.getElementById('modal-lat').value = e.lngLat.lat.toFixed(6);
        document.getElementById('modal-lng').value = e.lngLat.lng.toFixed(6);
        document.getElementById('modal-message').value = "";
        document.getElementById('modal-message').placeholder = "記憶を記述";
        document.getElementById('modal-password').value = "";
        document.getElementById('modal-password').placeholder = "***";
        warpContainer.innerHTML = "";

        modal.style.display = 'flex';
    });

    // 保存ボタン
    document.getElementById('modal-save').addEventListener('click', async () => {
        const inputLat = parseFloat(document.getElementById('modal-lat').value);
        const inputLng = parseFloat(document.getElementById('modal-lng').value);
        
        if (isNaN(inputLat) || isNaN(inputLng)) {
            alert("緯度と経度が正しくありません。");
            return;
        }

        const title = document.getElementById('modal-title').value;
        const message = document.getElementById('modal-message').value;
        const password = document.getElementById('modal-password').value;

        const warps = [];
        const warpRows = warpContainer.children;
        for (let i = 0; i < warpRows.length; i++) {
            const row = warpRows[i];
            const dest = row.querySelector('.warp-dest').value;
            const cost = row.querySelector('.warp-cost').value;
            const memo = row.querySelector('.warp-memo').value;

            if (dest && cost) {
                warps.push({ target_pin_id: dest, cost_minutes: parseInt(cost, 10), memo: memo || null });
            }
        }

        const pinData = {
            title: title,
            latitude: inputLat,
            longitude: inputLng,
            mode: "A",
            password: password || null,
            image_text: message || null,
            warps: warps
        };

        try {
            if (editingPinId) {
                await API.updatePin(editingPinId, pinData);
                alert("ピンの情報を更新しました");
            } else {
                await API.createPin(pinData);
                alert("記憶の刻印とワープ登録に成功しました");
            }

            modal.style.display = 'none';
            editingPinId = null;
            pendingLocation = null;
            loadPins();
        } catch (error) {
            alert("エラー: " + error.message);
        }
    });

    // キャンセルボタン
    document.getElementById('modal-cancel').addEventListener('click', () => {
        modal.style.display = 'none';
        warpContainer.innerHTML = '';
        editingPinId = null;
        pendingLocation = null;
    });

    loadPins();
}

function addWarpRow(initialData = null) {
    const row = document.createElement('div');
    row.style.cssText = "display: flex; flex-direction: column; gap: 5px; background: #1a1a1a; padding: 8px; border-left: 2px solid #777;";

    const select = document.createElement('select');
    select.className = "warp-dest";
    select.style.cssText = "width: 100%; box-sizing: border-box; background: #222; color: #fff; border: 1px solid #555; padding: 5px;";
    select.innerHTML = '<option value="">-- 接続先を選択 --</option>';
    window.cachedPins.forEach(pin => {
        const option = document.createElement('option');
        option.value = pin.pin_id;
        option.textContent = pin.title;
        select.appendChild(option);
    });

    const costRow = document.createElement('div');
    costRow.style.cssText = "display: flex; gap: 5px;";
    const costInput = document.createElement('input');
    costInput.className = "warp-cost";
    costInput.type = "number";
    costInput.placeholder = "所要(分)";
    costInput.min = "1";
    costInput.style.cssText = "flex: 1; background: #222; color: #fff; border: 1px solid #555; padding: 5px;";

    const btnRemove = document.createElement('button');
    btnRemove.textContent = "×";
    btnRemove.style.cssText = "background: #500; color: #fff; border: none; padding: 5px 10px; cursor: pointer;";
    btnRemove.onclick = () => row.remove();

    costRow.appendChild(costInput);
    costRow.appendChild(btnRemove);

    const memoInput = document.createElement('input');
    memoInput.className = "warp-memo";
    memoInput.type = "text";
    memoInput.placeholder = "メモ (例: 地下通路B口を使う)";
    memoInput.style.cssText = "width: 100%; box-sizing: border-box; background: #222; color: #fff; border: 1px solid #555; padding: 5px;";

    row.appendChild(select);
    row.appendChild(costRow);
    row.appendChild(memoInput);
    warpContainer.appendChild(row);

    if (initialData) {
        select.value = initialData.target_pin_id;
        costInput.value = initialData.cost_minutes;
        memoInput.value = initialData.memo || "";
    }
}

async function loadPins(searchQuery = "") {
    try {
        markers.forEach(m => m.remove());
        markers = [];

        const pins = await API.getNearbyPins(searchQuery);
        window.cachedPins = pins;

        pins.forEach(pin => {
            const marker = addMarkerToMap(pin.pin_id, pin.longitude, pin.latitude, pin.title);
            markers.push(marker);
        });
    } catch (error) {
        console.error("ピンの描画に失敗しました");
    }
}

function addMarkerToMap(pinId, lng, lat, title) {
    const marker = new maplibregl.Marker({ color: "#555555" })
        .setLngLat([lng, lat])
        .addTo(trajectoryMap);

    marker.getElement().addEventListener('click', async (e) => {
        e.stopPropagation(); 

        // [変更] EXPLORE または GUIDE モード時は、ピンをターゲットとして設定する
        if (appMode === 'EXPLORE' || appMode === 'GUIDE') {
            window.targetPinId = pinId;
            window.targetLoc = [lng, lat];
            alert(`【${title}】をターゲットに設定しました！`);
            
            // 現在地が取得できている場合は即座にHUD（コンパス）を更新
            if (window.currentLoc) {
                window.updateLocation(window.currentLoc[0], window.currentLoc[1]);
            }
        } else if (appMode === 'CREATE') {
            try {
                const pinDetail = await API.getPinDetail(pinId);

                editingPinId = pinId;
                
                document.getElementById('modal-title').value = pinDetail.title;
                document.getElementById('modal-lat').value = pinDetail.latitude.toFixed(6);
                document.getElementById('modal-lng').value = pinDetail.longitude.toFixed(6);
                document.getElementById('modal-message').value = "";
                document.getElementById('modal-message').placeholder = "※変更(再暗号化)する場合のみ入力";
                document.getElementById('modal-password').value = "";
                document.getElementById('modal-password').placeholder = "※変更(再暗号化)する場合のみ入力";

                warpContainer.innerHTML = '';
                pinDetail.warps.forEach(w => {
                    addWarpRow(w);
                });

                modal.style.display = 'flex';
            } catch (err) {
                console.error(err);
                alert("ピン情報の取得に失敗しました: \n" + err.message);
            }
        }
    });

    return marker;
}

initMap();