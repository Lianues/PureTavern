import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { picker } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { promptAction } from '@kit.ArkUI';
import { LocalWebAssetLoader } from '../web/LocalWebAssetLoader';

const APP_URL: string = 'https://puretavern.local/';

@Entry
@Component
struct PureTavernPage {
  private readonly webController: webview.WebviewController = new webview.WebviewController();
  private readonly assetLoader: LocalWebAssetLoader =
    new LocalWebAssetLoader(getContext(this) as common.UIAbilityContext);
  @State private lastBackTime: number = 0;

  aboutToAppear(): void {
    webview.WebviewController.setWebDebuggingAccess(false);
  }

  onBackPress(): boolean {
    if (this.webController.accessBackward()) {
      this.webController.backward();
      return true;
    }
    const now = Date.now();
    if (now - this.lastBackTime < 2000) {
      return false;
    }
    this.lastBackTime = now;
    promptAction.showToast({ message: '再按一次退出 PureTavern', duration: 2000 });
    return true;
  }

  private selectFile(result: FileSelectorResult): void {
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    const documentPicker = new picker.DocumentViewPicker();
    documentPicker
      .select(options)
      .then((uris: Array<string>) => result.handleFileList(uris))
      .catch((error: BusinessError) => {
        console.error(`PureTavern document picker failed: ${JSON.stringify(error)}`);
        result.handleFileList([]);
      });
  }

  build() {
    Stack() {
      Web({ src: APP_URL, controller: this.webController })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        .mediaPlayGestureAccess(true)
        .mixedMode(MixedMode.All)
        .onInterceptRequest((event: OnInterceptRequestEvent) => this.assetLoader.intercept(event))
        .onShowFileSelector((event: OnShowFileSelectorEvent) => {
          this.selectFile(event.result);
          return true;
        })
        .onPermissionRequest((event: OnPermissionRequestEvent) => {
          event.request.grant(event.request.getAccessibleResource());
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#171717')
  }
}
