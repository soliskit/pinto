import { useReducer } from 'react'

const Reducer = () => {
  const [show, toggle] = useReducer(state => !state, true)
  return (
    <>
      <h1>Toggle</h1>
      <div><button onClick={toggle}>Toggle Details</button></div>
      {show}
    </>
  )
}

export default Reducer
