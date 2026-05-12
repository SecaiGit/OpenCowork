import { useEffect, useRef, useState } from 'react'
import { formatTokensDecimal } from '@renderer/lib/format-tokens'

interface TokenCounterProps {
  /** Target token count to animate to */
  target: number
  /** Animation duration in milliseconds */
  duration?: number
  /** Starting value (for cumulative counting) */
  startFrom?: number
  /** Whether to animate or show immediately */
  animate?: boolean
}

/**
 * Animated token counter component with smooth counting animation
 */
export function TokenCounter({
  target,
  duration = 500,
  startFrom = 0,
  animate = true
}: TokenCounterProps): React.JSX.Element {
  const [animationState, setAnimationState] = useState(() => ({
    key: `${target}:${startFrom}:${duration}:${animate}`,
    value: startFrom
  }))
  const rafRef = useRef<number | undefined>(undefined)
  const startTimeRef = useRef<number | undefined>(undefined)
  const animationKey = `${target}:${startFrom}:${duration}:${animate}`
  const displayValue =
    !animate || target === startFrom
      ? target
      : animationState.key === animationKey
        ? animationState.value
        : startFrom

  useEffect(() => {
    if (!animate) {
      return
    }

    if (target === startFrom) {
      return
    }

    // Cancel any ongoing animation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    startTimeRef.current = performance.now()
    const startValue = startFrom
    const delta = target - startFrom

    const animateCount = (currentTime: number): void => {
      if (!startTimeRef.current) return

      const elapsed = currentTime - startTimeRef.current
      const progress = Math.min(elapsed / duration, 1)

      // Easing function: ease-out cubic for smooth deceleration
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = startValue + delta * eased

      setAnimationState({ key: animationKey, value: current })

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animateCount)
      } else {
        setAnimationState({ key: animationKey, value: target })
      }
    }

    rafRef.current = requestAnimationFrame(animateCount)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [target, duration, startFrom, animate, animationKey])

  return <span className="tabular-nums">{formatTokensDecimal(displayValue)}</span>
}
