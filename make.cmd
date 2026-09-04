rem run with /b to prevent automatic version bumping

del *.vsix
if not x%1 == x/b set OPT=--rev-version
call %APPDATA%\npm\tfx extension create %OPT% --manifest-globs ext.json --root src
