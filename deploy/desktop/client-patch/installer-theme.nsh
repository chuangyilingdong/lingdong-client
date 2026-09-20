; 灵动ai 安装器视觉：参考用户给的深红 + 小灵 + 蓝橙字标。
; 安装器不再跟随系统深浅色切换，避免同一品牌出现两套完全不同的第一印象。
!define INSTALLER_WINDOW_WIDTH 820
!define INSTALLER_WINDOW_HEIGHT 560
!define INSTALLER_BRAND_X 0
!define INSTALLER_BRAND_Y 0
!define INSTALLER_BRAND_WIDTH 330
!define INSTALLER_BRAND_HEIGHT 560
!define INSTALLER_BUTTON_X 580
!define INSTALLER_BUTTON_Y 482
!define INSTALLER_BUTTON_WIDTH 180
!define INSTALLER_BUTTON_HEIGHT 48
!define INSTALLER_BUTTON_DIAMETER 20
!define INSTALLER_PROGRESS_X 360
!define INSTALLER_PROGRESS_Y 500
!define INSTALLER_PROGRESS_WIDTH 400
!define INSTALLER_PROGRESS_HEIGHT 6
!define INSTALLER_PROGRESS_DIAMETER 4
!define INSTALLER_STATUS_Y 518
!define INSTALLER_STATUS_HEIGHT 22
!define INSTALLER_FONT "Microsoft YaHei UI"
!define INSTALLER_BUTTON_FONT_SIZE 16
!define INSTALLER_STATUS_FONT_SIZE 14

Var InstallerTheme
Var InstallerBgHex
Var InstallerTextHex
Var InstallerBgArgb
Var InstallerBgColorref
Var InstallerTextColorref
Var InstallerPrimary
Var InstallerPrimaryHover
Var InstallerPrimaryPressed
Var InstallerControlHover
Var InstallerTrack
Var InstallerButtonText
Var InstallerBorder

!macro InstallerControlColors HANDLE
    ; 深红底、白字；编辑框与状态文字都保持同一套品牌背景。
    SetCtlColors ${HANDLE} FFFFFF 7E1123
!macroend

Function InstallerResolveTheme
    ; /THEME 参数仍接受，但任何主题都使用同一套红/蓝/橙品牌视觉。
    StrCpy $InstallerBgHex "7E1123"
    StrCpy $InstallerTextHex "FFFFFF"
    StrCpy $InstallerBgArgb 0xFF7E1123
    StrCpy $InstallerBgColorref 0x23117E
    StrCpy $InstallerTextColorref 0xFFFFFF
    StrCpy $InstallerPrimary 0xFFE63950
    StrCpy $InstallerPrimaryHover 0xFFF24D64
    StrCpy $InstallerPrimaryPressed 0xFFC7253B
    StrCpy $InstallerControlHover 0xFF65101D
    StrCpy $InstallerTrack 0xFFFFA8B6
    StrCpy $InstallerButtonText 0xFFFFFF
    StrCpy $InstallerBorder 0xFFD98C98
FunctionEnd
