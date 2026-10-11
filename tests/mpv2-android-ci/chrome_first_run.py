#!/usr/bin/env python3
"""Dismiss Android Chrome first-run screens using accessible UI labels."""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

SKIP = (
    'use without an account',
    'continue without an account',
    'no thanks',
    'not now',
    'skip',
    'maybe later',
    'got it',
    'no, thanks',
    'decline',
    'accept & continue',
    'accept and continue',
)
BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def adb(*args, timeout=15):
    return subprocess.run(['adb', *args], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, timeout=timeout, check=False)


def find_choice(text):
    try:
        nodes = ET.fromstring(text).iter()
    except ET.ParseError:
        return None
    choices = []
    for node in nodes:
        label = (node.attrib.get('text', '') + ' ' + node.attrib.get('content-desc', '')).strip().lower()
        if not label:
            continue
        bounds = BOUNDS.search(node.attrib.get('bounds', ''))
        if not bounds:
            continue
        for rank, keyword in enumerate(SKIP):
            if keyword in label:
                left, top, right, bottom = map(int, bounds.groups())
                if right > left and bottom > top:
                    choices.append((rank, (left + right) // 2, (top + bottom) // 2, keyword))
                break
    return min(choices) if choices else None


os.makedirs('artifacts/mpv2-android', exist_ok=True)
for attempt in range(8):
    try:
        with open(f'artifacts/mpv2-android/onboarding-{attempt}.png', 'wb') as screenshot:
            subprocess.run(['adb', 'exec-out', 'screencap', '-p'],
                           stdout=screenshot, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        pass
    adb('shell', 'uiautomator', 'dump', '/sdcard/mpv2-ci-window.xml', timeout=25)
    result = adb('shell', 'cat', '/sdcard/mpv2-ci-window.xml')
    with open(f'artifacts/mpv2-android/ui-{attempt}.xml', 'w', encoding='utf-8') as output:
        output.write(result.stdout)
    choice = find_choice(result.stdout)
    if not choice:
        # Google Play emulator Chrome can expose no accessibility bounds until
        # the first welcome screen has been dismissed. Tap 'Use without an account'
        # at its confirmed location, normalized to emulator screen dimensions.
        if attempt <= 1:
            display = adb('shell', 'wm', 'size').stdout
            found = re.search(r'(\d+)x(\d+)', display)
            if found:
                width, height = map(int, found.groups())
            else:
                width, height = 1080, 2400
            x, y = int(width * 0.5), int(height * 0.87)
            print(f'[chrome-onboarding] No UI labels; fallback tap {x},{y} (step {attempt})')
            adb('shell', 'input', 'tap', str(x), str(y))
            time.sleep(3.5)
            continue
        print('[chrome-onboarding] No accessible prompt after fallback')
        break
    _, x, y, keyword = choice
    print(f'[chrome-onboarding] Tap {keyword} at {x},{y}')
    adb('shell', 'input', 'tap', str(x), str(y))
    time.sleep(3)
else:
    print('[chrome-onboarding] Maximum welcome steps reached')
