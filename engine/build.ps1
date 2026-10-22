# Builds hellpane-engine.exe from doomgeneric and the HellPane platform layer.
# Needs gcc or clang on PATH (llvm-mingw or MinGW-w64).
# Output goes to plugin\bin\ so `claude --plugin-dir plugin` finds it.
param(
    [string]$Doomgeneric = '',
    [string]$Out = (Join-Path $PSScriptRoot '..\plugin\bin\hellpane-engine.exe')
)
$ErrorActionPreference = 'Stop'

if (-not $Doomgeneric) {
    # The public repo keeps the sources in doomgeneric\, the work folder in vendor-doomgeneric\doomgeneric\
    $Doomgeneric = @(
        (Join-Path $PSScriptRoot '..\doomgeneric'),
        (Join-Path $PSScriptRoot '..\vendor-doomgeneric\doomgeneric')
    ) | Where-Object { Test-Path (Join-Path $_ 'doomgeneric.c') } | Select-Object -First 1
    if (-not $Doomgeneric) { throw 'doomgeneric sources not found' }
}

$names = @(
    'dummy', 'am_map', 'doomdef', 'doomstat', 'dstrings', 'd_event', 'd_items', 'd_iwad', 'd_loop',
    'd_main', 'd_mode', 'd_net', 'f_finale', 'f_wipe', 'g_game', 'hu_lib', 'hu_stuff', 'info',
    'i_cdmus', 'i_endoom', 'i_joystick', 'i_scale', 'i_sound', 'i_system', 'i_timer', 'memio',
    'm_argv', 'm_bbox', 'm_cheat', 'm_config', 'm_controls', 'm_fixed', 'm_menu', 'm_misc',
    'm_random', 'p_ceilng', 'p_doors', 'p_enemy', 'p_floor', 'p_inter', 'p_lights', 'p_map',
    'p_maputl', 'p_mobj', 'p_plats', 'p_pspr', 'p_saveg', 'p_setup', 'p_sight', 'p_spec',
    'p_switch', 'p_telept', 'p_tick', 'p_user', 'r_bsp', 'r_data', 'r_draw', 'r_main', 'r_plane',
    'r_segs', 'r_sky', 'r_things', 'sha1', 'sounds', 'statdump', 'st_lib', 'st_stuff', 's_sound',
    'tables', 'v_video', 'wi_stuff', 'w_checksum', 'w_file', 'w_main', 'w_wad', 'z_zone',
    'w_file_stdc', 'i_input', 'i_video', 'doomgeneric'
)
$sources = $names | ForEach-Object { Join-Path $Doomgeneric "$_.c" }
$sources += Join-Path $PSScriptRoot 'doomgeneric_hellpane.c'

$cc = if (Get-Command gcc -ErrorAction SilentlyContinue) { 'gcc' } else { 'clang' }
$flags = @(
    '-O2', '-w', '-D_DEFAULT_SOURCE',
    '-DDOOMGENERIC_RESX=320', '-DDOOMGENERIC_RESY=200',
    "-I$Doomgeneric"
)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
& $cc @flags @sources -o $Out -lm
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
Write-Host "built $Out"
