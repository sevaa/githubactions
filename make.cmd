rem run with /b to prevent automatic version bumping

del *.vsix
rem The Powershell files should be in path!!!
if not x%1 == x/b powershell BumpTaskVersion.ps1 -Folder src\RunWorkflow & powershell BumpExtVersion.ps1 -File src\ext.json
call %APPDATA%\npm\tfx extension create --manifest-globs ext.json --root src
