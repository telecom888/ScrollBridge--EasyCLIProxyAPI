; Keep installations writable by the current account: settings live beside exe.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Only check the executable at this installation path. Never terminate another
; portable copy of ScrollBridge that may be serving active requests.
!macro customCheckAppRunning
  Push $R0
  Push $R1
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $R1 0
    ${Do}
      ClearErrors
      FileOpen $R0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
      ${IfNot} ${Errors}
        FileClose $R0
        ${Break}
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 >= 10
        MessageBox MB_OK|MB_ICONEXCLAMATION "请关闭此安装目录中的卷桥后重试，并确认目录可写。" /SD IDOK
        SetErrorLevel 2
        Abort
      ${EndIf}
      Sleep 100
    ${Loop}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!ifdef BUILD_UNINSTALLER
  Var ScrollBridgeConfigSaved
!endif
!macro customUnInstall
  StrCpy $ScrollBridgeConfigSaved "0"
  ${If} ${FileExists} "$INSTDIR\scrollbridge.json"
    InitPluginsDir
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\scrollbridge.json" "$PLUGINSDIR\scrollbridge-config.json"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法保留配置，已取消卸载。" /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    StrCpy $ScrollBridgeConfigSaved "1"
  ${EndIf}
!macroend

; The default uninstaller removes the installation directory. Restore the
; encrypted configuration afterward, including during an in-place upgrade.
!macro customUnInstallSection
  Section "un.PreserveConfiguration"
    ${If} $ScrollBridgeConfigSaved == "1"
      CreateDirectory "$INSTDIR"
      ClearErrors
      CopyFiles /SILENT "$PLUGINSDIR\scrollbridge-config.json" "$INSTDIR\scrollbridge.json"
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "配置恢复失败，请检查安装目录的写入权限。" /SD IDOK
        SetErrorLevel 2
      ${EndIf}
    ${EndIf}
  SectionEnd
!macroend
