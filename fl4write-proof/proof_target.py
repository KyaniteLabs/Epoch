"""E2E proof target for the FL4WRITE fix lane (planted defect, the org's
learning-15 inaugural pattern). The defect is intentional; file is throwaway."""


def median(values: list[float]) -> float:
    """Return the median."""
    n = len(values)
    if n == 0:
        raise ValueError("empty")
    sorted_values = sorted(values)
    if n % 2 == 1:
        return sorted_values[n // 2]
    return (sorted_values[n // 2 - 1] + sorted_values[n // 2]) / 2
