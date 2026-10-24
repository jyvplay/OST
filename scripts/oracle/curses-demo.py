#!/usr/bin/env python3
"""TT44 TEST-ONLY: a small ncurses program (real terminfo output for xterm-256color): alternate screen, boxes with
line drawing, 256 colours, attributes, a scrolling sub-window, insert/delete line, wide characters."""
import curses, time

def main(scr):
    curses.start_color(); curses.use_default_colors()
    for i in range(1, 64): curses.init_pair(i, i * 4 % 256, -1)
    scr.box(); scr.addstr(0, 2, " Fusion VT test ", curses.A_BOLD | curses.A_REVERSE)
    for i in range(1, 12):
        scr.addstr(i, 2, f"pair {i:2d} ", curses.color_pair(i) | (curses.A_UNDERLINE if i % 3 == 0 else 0) | (curses.A_BOLD if i % 2 else 0))
    scr.addstr(13, 2, "wide: 日本語テキスト 한국어 😀 end")
    win = curses.newwin(8, 30, 2, 40); win.box(); win.refresh()
    sub = win.derwin(6, 28, 1, 1); sub.scrollok(True)
    for i in range(20): sub.addstr(f"line {i} " + "x" * (i % 15) + "\n"); sub.refresh(); time.sleep(0.005)
    scr.move(16, 2); scr.insertln(); scr.addstr(16, 2, "inserted line", curses.A_DIM)
    scr.move(18, 2); scr.deleteln()
    scr.addstr(20, 2, "done", curses.A_BLINK)
    scr.refresh(); time.sleep(0.2)
    scr.getch()

curses.wrapper(main)
