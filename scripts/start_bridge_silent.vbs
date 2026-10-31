' BuildBrowser Translation - start the live bridge without a console window.
'
' Double-click this file (or use scripts\install_bridge_autostart.bat to run it at
' logon). It does nothing if a bridge is already listening on the port.
'
' Logs go to logs\bridge.log next to this script's parent directory.

Option Explicit

Dim shell, fso, root, node, cmd, logDir, logFile

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logDir = root & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
logFile = logDir & "\bridge.log"

' Prefer a portable node next to the repo, then PATH.
node = root & "\node\node.exe"
If Not fso.FileExists(node) Then node = "node"

cmd = "cmd /c cd /d """ & root & """ && """ & node & """ tools\bridge\bridge.js >> """ & logFile & """ 2>&1"
shell.Run cmd, 0, False
