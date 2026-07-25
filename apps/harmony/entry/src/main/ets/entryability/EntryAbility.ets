import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

const LOG_DOMAIN: number = 0x5054;
const LOG_TAG: string = 'PureTavern';

export default class EntryAbility extends UIAbility {
  private mainWindow: window.Window | undefined = undefined;

  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(LOG_DOMAIN, LOG_TAG, 'PureTavern HarmonyOS NEXT ability created.');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.mainWindow = windowStage.getMainWindowSync();
    this.applyFullscreen();
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        hilog.error(LOG_DOMAIN, LOG_TAG, 'Failed to load PureTavern: %{public}s', JSON.stringify(error));
      }
    });
  }

  onForeground(): void {
    this.applyFullscreen();
  }

  onWindowStageDestroy(): void {
    this.mainWindow = undefined;
  }

  private applyFullscreen(): void {
    const mainWindow = this.mainWindow;
    if (!mainWindow) {
      return;
    }
    mainWindow.setWindowLayoutFullScreen(true);
    mainWindow.setSpecificSystemBarEnabled('status', false);
    mainWindow.setSpecificSystemBarEnabled('navigationIndicator', false);
  }
}
