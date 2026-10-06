#define AppName "Tienda Nápoles Offline"
#define AppVersion "1.0.3"

[Setup]
AppId={{1B759C3D-EEAC-42F1-8C91-A400775027C1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Tienda Nápoles
DefaultDirName={localappdata}\Programs\Tienda Napoles Offline
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Tienda-Napoles-Offline-Setup-{#AppVersion}
SetupIconFile=..\tienda-napoles.ico
UninstallDisplayIcon={app}\TiendaNapolesOffline.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
Source: "build\TiendaNapolesOffline.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "tienda-napoles-installed.marker"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\offline-server.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\cash-drawer-printer.cs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\offline-login-vault.cs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\admin.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\index.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\app.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\service-worker.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\style.css"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\manifest.webmanifest"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\pwa-icon.svg"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tienda-napoles.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\images\*"; DestDir: "{app}\images"; Flags: ignoreversion
Source: "..\sound\*"; DestDir: "{app}\sound"; Flags: ignoreversion
Source: "..\vendor\*"; DestDir: "{app}\vendor"; Flags: ignoreversion

[Icons]
Name: "{autodesktop}\Tienda Nápoles"; Filename: "{app}\TiendaNapolesOffline.exe"; WorkingDir: "{app}"; IconFilename: "{app}\tienda-napoles.ico"
Name: "{autoprograms}\Tienda Nápoles Offline"; Filename: "{app}\TiendaNapolesOffline.exe"; WorkingDir: "{app}"; IconFilename: "{app}\tienda-napoles.ico"
