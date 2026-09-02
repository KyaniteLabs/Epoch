"""E2E proof target for the FL4WRITE fix lane (planted defect, the org's
learning-15 inaugural pattern). The defect is intentional; file is throwaway."""


def median(values: list[float]) -> float:
    """Return the median. BUG (planted): input is never sorted before
    indexing, so unsorted inputs return a wrong element, not the median."""
    n = len(values)
    if n == 0:
        raise ValueError("empty")
    if n % 2 == 1:
        return values[n // 2]
    return (values[n // 2 - 1] + values[n // 2]) / 2
