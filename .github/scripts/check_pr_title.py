"""Trusted-base title checker. Pure data only; no network or repository effects."""
import re

LEADING_TAG = re.compile(r'^\[[^\]]*\]')


def check(title):
    if LEADING_TAG.match(title):
        return ['Start the title without a leading bracketed tag such as "[CI]".']
    return []
