// HellPane platform layer for doomgeneric.
//
// Frames: each one goes to stdout as a single text line
//   "HPF <w> <h> <base64 of w*h RGB bytes>"
// (a newline is written before it too, so DOOM's own printf output can never
// glue onto the start of a frame line). The plugin reads stdout and paints.
//
// Keys: the plugin rewrites a small text file (path from -hpkeys):
//   HP1 <w> <h> <quit>
//   <seq> <doomkey>
//   ...
//   END
// Each line is one key press the terminal reported (autorepeat included).
// Terminals never report key release, so a release is synthesized once a key
// has gone without a press for a while.

#include "doomkeys.h"
#include "doomgeneric.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <io.h>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

// From m_argv.h, which can't be included beside windows.h (both define boolean).
extern int myargc;
extern char **myargv;
int M_CheckParmWithArgs(char *check, int num_args);

#define MAX_W 320
#define MAX_H 200

// A first press holds the key this long; each repeat extends it by REPEAT_HOLD_MS.
#define FIRST_HOLD_MS  220
#define REPEAT_HOLD_MS 140
#define FRAME_MIN_MS   45
#define KEYFILE_POLL_MS 15

static int s_OutW = 160;
static int s_OutH = 100;
static const char *s_KeyPath = NULL;

static LARGE_INTEGER s_Freq;
static LARGE_INTEGER s_Start;

static uint32_t s_LastFrameMs = 0;
static uint32_t s_LastPollMs = 0;
static long s_LastSeq = -1;

static uint32_t s_HoldUntil[256];
static int s_Held[256];

#define KEYQUEUE_SIZE 64
static unsigned short s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyQueueWrite = 0;
static unsigned int s_KeyQueueRead = 0;

static unsigned char s_Rgb[MAX_W * MAX_H * 3];
static char s_Line[MAX_W * MAX_H * 4 + 64];

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64_encode(const unsigned char *in, size_t len, char *out)
{
    size_t i, o = 0;
    for (i = 0; i + 2 < len; i += 3)
    {
        uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = B64[v & 63];
    }
    if (i < len)
    {
        uint32_t v = in[i] << 16;
        if (i + 1 < len) v |= in[i + 1] << 8;
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = (i + 1 < len) ? B64[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    return o;
}

static void clamp_size(int *w, int *h)
{
    if (*w < 16) *w = 16;
    if (*w > MAX_W) *w = MAX_W;
    if (*h < 10) *h = 10;
    if (*h > MAX_H) *h = MAX_H;
}

static void queue_key(int pressed, unsigned char key)
{
    s_KeyQueue[s_KeyQueueWrite] = (unsigned short)((pressed << 8) | key);
    s_KeyQueueWrite = (s_KeyQueueWrite + 1) % KEYQUEUE_SIZE;
}

static void poll_keyfile(uint32_t now)
{
    FILE *f;
    char buf[4096];
    size_t n;
    char *line, *save;
    int w, h, quit;

    if (!s_KeyPath) return;

    f = fopen(s_KeyPath, "rb");
    if (!f) return;
    n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = 0;

    // A half-written file has no END yet: skip it and read it next poll.
    if (!strstr(buf, "\nEND")) return;

    line = strtok_s(buf, "\r\n", &save);
    if (!line || sscanf(line, "HP1 %d %d %d", &w, &h, &quit) != 3) return;
    if (quit) exit(0);
    clamp_size(&w, &h);
    s_OutW = w;
    s_OutH = h;

    while ((line = strtok_s(NULL, "\r\n", &save)) != NULL)
    {
        long seq;
        int key;
        if (strcmp(line, "END") == 0) break;
        if (sscanf(line, "%ld %d", &seq, &key) != 2) continue;
        if (seq <= s_LastSeq) continue;
        s_LastSeq = seq;
        if (key <= 0 || key > 255) continue;

        if (!s_Held[key])
        {
            s_Held[key] = 1;
            s_HoldUntil[key] = now + FIRST_HOLD_MS;
            queue_key(1, (unsigned char)key);
        }
        else
        {
            s_HoldUntil[key] = now + REPEAT_HOLD_MS;
        }
    }
}

static void release_expired(uint32_t now)
{
    int k;
    for (k = 1; k < 256; k++)
    {
        if (s_Held[k] && (int32_t)(now - s_HoldUntil[k]) >= 0)
        {
            s_Held[k] = 0;
            queue_key(0, (unsigned char)k);
        }
    }
}

void DG_Init()
{
    int p;

    QueryPerformanceFrequency(&s_Freq);
    QueryPerformanceCounter(&s_Start);

    _setmode(_fileno(stdout), _O_BINARY);
    setvbuf(stdout, NULL, _IOFBF, 1 << 20);

    p = M_CheckParmWithArgs("-hpkeys", 1);
    if (p) s_KeyPath = myargv[p + 1];
    p = M_CheckParmWithArgs("-hpw", 1);
    if (p) s_OutW = atoi(myargv[p + 1]);
    p = M_CheckParmWithArgs("-hph", 1);
    if (p) s_OutH = atoi(myargv[p + 1]);
    clamp_size(&s_OutW, &s_OutH);

    memset(s_Held, 0, sizeof(s_Held));
}

void DG_DrawFrame()
{
    uint32_t now = DG_GetTicksMs();
    int x, y, w = s_OutW, h = s_OutH;
    unsigned char *o = s_Rgb;
    size_t len;

    if (now - s_LastFrameMs < FRAME_MIN_MS) return;
    s_LastFrameMs = now;

    // Box filter from DOOMGENERIC_RESX x DOOMGENERIC_RESY down to w x h.
    for (y = 0; y < h; y++)
    {
        int y0 = y * DOOMGENERIC_RESY / h;
        int y1 = (y + 1) * DOOMGENERIC_RESY / h;
        if (y1 <= y0) y1 = y0 + 1;
        for (x = 0; x < w; x++)
        {
            int x0 = x * DOOMGENERIC_RESX / w;
            int x1 = (x + 1) * DOOMGENERIC_RESX / w;
            int sx, sy, cnt = 0;
            uint32_t r = 0, g = 0, b = 0;
            if (x1 <= x0) x1 = x0 + 1;
            for (sy = y0; sy < y1; sy++)
            {
                const pixel_t *row = DG_ScreenBuffer + sy * DOOMGENERIC_RESX;
                for (sx = x0; sx < x1; sx++)
                {
                    uint32_t p = row[sx];
                    r += (p >> 16) & 0xff;
                    g += (p >> 8) & 0xff;
                    b += p & 0xff;
                    cnt++;
                }
            }
            *o++ = (unsigned char)(r / cnt);
            *o++ = (unsigned char)(g / cnt);
            *o++ = (unsigned char)(b / cnt);
        }
    }

    len = (size_t)sprintf(s_Line, "\nHPF %d %d ", w, h);
    len += base64_encode(s_Rgb, (size_t)w * h * 3, s_Line + len);
    s_Line[len++] = '\n';

    // The plugin closing the pipe ends the game.
    if (fwrite(s_Line, 1, len, stdout) != len || fflush(stdout) != 0) exit(0);
}

void DG_SleepMs(uint32_t ms)
{
    Sleep(ms);
}

uint32_t DG_GetTicksMs()
{
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return (uint32_t)((now.QuadPart - s_Start.QuadPart) * 1000 / s_Freq.QuadPart);
}

int DG_GetKey(int *pressed, unsigned char *doomKey)
{
    if (s_KeyQueueRead == s_KeyQueueWrite)
    {
        uint32_t now = DG_GetTicksMs();
        if (now - s_LastPollMs >= KEYFILE_POLL_MS)
        {
            s_LastPollMs = now;
            poll_keyfile(now);
        }
        release_expired(now);
    }

    if (s_KeyQueueRead == s_KeyQueueWrite) return 0;

    *pressed = s_KeyQueue[s_KeyQueueRead] >> 8;
    *doomKey = s_KeyQueue[s_KeyQueueRead] & 0xff;
    s_KeyQueueRead = (s_KeyQueueRead + 1) % KEYQUEUE_SIZE;
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

int main(int argc, char **argv)
{
    doomgeneric_Create(argc, argv);

    for (;;)
    {
        doomgeneric_Tick();
    }

    return 0;
}
