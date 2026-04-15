declare namespace YT {
  class Player {
    constructor(
      elementId: string,
      options: {
        videoId: string;
        playerVars?: Record<string, unknown>;
        events?: {
          onReady?: () => void;
          onStateChange?: (event: { data: number }) => void;
        };
      },
    );
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    playVideo(): void;
    pauseVideo(): void;
    getCurrentTime(): number;
    getPlayerState(): number;
    destroy(): void;
  }
}
