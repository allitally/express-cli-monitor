export class ImageReceiver {
    constructor() {
        // 総受信フレーム数
        this.receiveCount = 0;

        // 最後に受信したセッションID
        this.lastSessionId = null;

        // 最後に受信したフレーム番号
        this.lastFrameNumber = null;

        // FPS計測用
        this.fps = 0;
        this.fpsFrameCount = 0;
        this.fpsStartTime = Date.now();

        // FPSを再計算する間隔
        this.fpsUpdateIntervalMs = 10_000;
    }

    /**
     * Socket.IOイベントハンドラ
     *
     * socket.on("image", receiver.onImage);
     *
     * @param {Buffer|Uint8Array} imageData JPEG画像バイナリ
     * @param {string} frameInfo "<sessionId>:<frameNumber>"
     */
    onImage = (imageData, frameInfo) => {
        /*
         * JPEG画像を1フレーム受信
         */
        this.receiveCount++;
        this.fpsFrameCount++;

        /*
         * "<sessionId>:<frameNumber>" を解析
         */
        if (typeof frameInfo === "string") {
            const parts = frameInfo.split(":");

            if (parts.length === 2) {
                const sessionId = Number(parts[0]);
                const frameNumber = Number(parts[1]);

                if (
                    Number.isInteger(sessionId) &&
                        Number.isInteger(frameNumber)
                ) {
                    this.lastSessionId = sessionId;
                    this.lastFrameNumber = frameNumber;
                }
            }
        }

        /*
         * 約10秒ごとにFPSを更新する。
         *
         * 実際に経過した時間で割るため、
         * イベントループの遅延があっても補正される。
         */
        const now = Date.now();
        const elapsedMs = now - this.fpsStartTime;

        if (elapsedMs >= this.fpsUpdateIntervalMs) {
            this.fps =
                this.fpsFrameCount * 1000 / elapsedMs;

            this.fpsFrameCount = 0;
            this.fpsStartTime = now;
        }

        /*
         * imageData がJPEG画像本体。
         *
         * 必要ならここで保存、デコード、転送などを行う。
         */
    };

    /**
     * 総受信フレーム数
     */
    getReceiveCount() {
        return this.receiveCount;
    }

    /**
     * 最後に受信したセッションID
     */
    getLastSessionId() {
        return this.lastSessionId;
    }

    /**
     * 最後に受信したフレーム番号
     */
    getLastFrameNumber() {
        return this.lastFrameNumber;
    }

    /**
     * 受信FPS
     *
     * 約10秒ごとに更新される。
     */
    getFps() {
        return this.fps;
    }
}
