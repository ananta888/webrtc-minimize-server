package main

const (
	thermalDegradedMilliCelsius = 80_000
	thermalDrainingMilliCelsius = 90_000
)

func thermalHealth(base string, samples []int64) string {
	if base != "healthy" {
		return base
	}
	maximum := int64(-1)
	for _, sample := range samples {
		if sample >= -20_000 && sample <= 150_000 && sample > maximum {
			maximum = sample
		}
	}
	if maximum >= thermalDrainingMilliCelsius {
		return "draining"
	}
	if maximum >= thermalDegradedMilliCelsius {
		return "degraded"
	}
	return "healthy"
}

func (c *client) currentHealth() string {
	if c.healthProbe != nil {
		value := c.healthProbe()
		if oneOf(value, "healthy", "degraded", "draining") {
			return value
		}
		return "draining"
	}
	return thermalHealth(c.capability.health, readSystemThermalMilliCelsius())
}
