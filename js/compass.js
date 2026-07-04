window.currentLoc = [139.7000, 35.6900]; // 初期現在地(ダミー)
window.targetLoc = null;
window.targetPinId = null;

window.addEventListener('deviceorientation', (e) => {
    if (!window.currentLoc || !window.targetLoc || e.webkitCompassHeading === undefined) return;
    const bearing = turf.bearing(turf.point(window.currentLoc), turf.point(window.targetLoc));
    const rotation = bearing - e.webkitCompassHeading;
    document.getElementById('compass-arrow').style.transform = `rotate(${rotation}deg)`;
});

window.updateLocation = function(lng, lat) {
    window.currentLoc = [lng, lat];
    
    if (window.targetLoc) {
        const dist = turf.distance(turf.point(window.currentLoc), turf.point(window.targetLoc), {units: 'meters'});
        document.getElementById('distance').innerText = `${Math.round(dist)} m`;
        
        const btn = document.getElementById('action-btn');
        if (dist <= 50) {
            btn.disabled = false;
            btn.innerText = "PICK (復号化)";
            btn.onclick = async () => {
                const password = prompt("パスワードを入力してください:");
                if (password === null) return;
                
                try {
                    const result = await API.pickPin(window.targetPinId, {
                        current_lat: window.currentLoc[1],
                        current_lng: window.currentLoc[0],
                        password: password
                    });
                    alert(`復号成功！\n中身: ${result.decrypted_image_base64}\n新ハッシュ: ${result.new_hash}`);
                } catch (error) {
                    alert(`復号失敗: ${error.message}`);
                }
            };
        } else {
            btn.disabled = true;
            btn.innerText = "接近中...";
            btn.onclick = null;
        }
    }
};