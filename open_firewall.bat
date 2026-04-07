@echo off
echo Открываю порт 3000...
netsh advfirewall firewall add rule name="Algebra Platform 3000" protocol=TCP dir=in localport=3000 action=allow
echo Разрешаю ping...
netsh advfirewall firewall add rule name="Allow ICMPv4 In" protocol=icmpv4:8,any dir=in action=allow
echo.
echo Готово! Порт 3000 открыт.
pause
